/**
 * Free colour choice: an HSV wheel (hue by angle, saturation by radius) with a
 * value bar beside it and a hex field under it.
 *
 * The wheel is a `<canvas>` painted per pixel rather than a stack of CSS
 * gradients: a conic gradient can do hue and a radial can do saturation, but
 * compositing the two never lands on the right colour in the middle radii, and
 * the whole point of a wheel is that the colour under the cursor IS the colour
 * you get. Painted at the CURRENT value so the wheel dims with the bar — a
 * wheel that stays bright while the bar is down lies about the result.
 *
 * The value bar is a plain CSS gradient (chosen colour at full value -> black),
 * which is exactly right and needs no canvas.
 *
 * The hex field is not a convenience: matching a house colour or a colour from
 * a spec means typing the number, and no amount of wheel precision replaces
 * that.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { alphaOf, hexToHsv, hsvToHex, parseHex, rgbToHex, withAlpha, type Hsv } from "../../color";

/** Rendered size (CSS px) of the wheel. Backing store is scaled by DPR. */
const WHEEL_SIZE = 132;

/** Checkerboard behind anything that can be see-through, so alpha is legible. */
const CHECKER = "repeating-conic-gradient(#ffffff40 0% 25%, #00000040 0% 50%) 50% / 6px 6px";

/**
 * Within this much of an end, the slider snaps to it exactly. Sized against the
 * bar's real width (~110 px), where a tighter zone is a sub-pixel target.
 *
 * Not cosmetic. Fully opaque is a DIFFERENT render path from 99% opaque —
 * `transparent: false` with single-sided faces, versus blending with
 * double-sided faces (see `tintDefinition` in model-tint.ts) — and the two are
 * indistinguishable on screen at that alpha. Without a snap, a user dragging to
 * what looks like the end leaves the model on the transparent path, paying for
 * blending and losing the depth behaviour of a solid, with nothing visible to
 * explain why.
 */
const ALPHA_SNAP = 0.04;

/**
 * Quantise to the 1/255 grid the hex can actually store, so the number the
 * slider reports is the number that gets applied — then lock the ends.
 */
function snapAlpha(t: number): number {
  if (t >= 1 - ALPHA_SNAP) return 1;
  if (t <= ALPHA_SNAP) return 0;
  return Math.round(t * 255) / 255;
}

interface ColorWheelProps {
  /** Current colour, `#rrggbb` or `#rrggbbaa`. */
  value: string;
  /** Fires on every drag step, so callers get a live preview. */
  onChange: (hex: string) => void;
  /**
   * Show the opacity slider. Off by default: not every colour this control
   * edits can be see-through, and a slider that does nothing is worse than no
   * slider.
   */
  alpha?: boolean;
}

export default function ColorWheel({ value, onChange, alpha = false }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const alphaBarRef = useRef<HTMLDivElement>(null);

  /**
   * HSV is the control's own state, not derived from `value` on every render.
   * It has to be: hue and saturation are UNRECOVERABLE from a hex once value
   * hits 0 (black is h=0,s=0) or saturation hits 0 (grey has no hue), so
   * round-tripping through the hex would snap the knob to the centre the moment
   * the user dragged the bar to the bottom. Re-synced below only when `value`
   * changes to something this control did not produce.
   */
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setHsv(hexToHsv(value));
    setOpacity(alphaOf(value));
  }, [value]);

  /**
   * Alpha is tracked separately from HSV because it is not part of it — and,
   * like hue and saturation, it has to survive positions where the hex cannot
   * express it (at alpha 0 the colour is gone but the wheel must stay where the
   * user left it).
   */
  const [opacity, setOpacity] = useState(() => alphaOf(value));

  const emit = useCallback(
    (next: Hsv, nextOpacity = opacity) => {
      setHsv(next);
      setOpacity(nextOpacity);
      const hex = withAlpha(hsvToHex(next), nextOpacity);
      lastEmitted.current = hex;
      onChange(hex);
    },
    [onChange, opacity],
  );

  // Repaint the disc whenever the value changes (hue/saturation are positional,
  // so they do not affect the pixels — only `v` does).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(WHEEL_SIZE * dpr);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(size, size);
    const data = image.data;
    const radius = size / 2;
    const v = hsv.v;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - radius + 0.5;
        const dy = y - radius + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * size + x) * 4;
        if (dist > radius) {
          data[i + 3] = 0;
          continue;
        }
        // Hue anticlockwise from the +x axis so the wheel reads the same way
        // round as every other colour wheel; saturation linear in radius.
        const hue = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
        const sat = Math.min(1, dist / radius);
        const rgb = parseHex(hsvToHex({ h: hue, s: sat, v }))!;
        data[i] = rgb.r;
        data[i + 1] = rgb.g;
        data[i + 2] = rgb.b;
        // Feather the last pixel of the rim, or the disc looks jagged at DPR 1.
        data[i + 3] = dist > radius - 1 ? Math.round(255 * (radius - dist)) : 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [hsv.v]);

  /** Pointer position -> hue/saturation, for both the initial press and the drag. */
  const pickFromWheel = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wheelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const radius = rect.width / 2;
      const dx = clientX - rect.left - radius;
      const dy = clientY - rect.top - radius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const hue = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
      // Clamped, not rejected: dragging past the rim should ride round the
      // outside at full saturation rather than stop responding.
      emit({ h: hue, s: Math.min(1, dist / radius), v: hsv.v });
    },
    [emit, hsv.v],
  );

  const pickFromBar = useCallback(
    (clientY: number) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const t = (clientY - rect.top) / rect.height;
      emit({ h: hsv.h, s: hsv.s, v: Math.max(0, Math.min(1, 1 - t)) });
    },
    [emit, hsv.h, hsv.s],
  );

  const pickFromAlphaBar = useCallback(
    (clientX: number) => {
      const rect = alphaBarRef.current?.getBoundingClientRect();
      if (!rect) return;
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      emit(hsv, snapAlpha(t));
    },
    [emit, hsv],
  );

  /**
   * Drag with pointer capture on the element that was pressed, so the gesture
   * keeps working when the cursor leaves the little disc — which it constantly
   * does at this size.
   */
  const dragHandlers = (pick: (x: number, y: number) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pick(e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      pick(e.clientX, e.clientY);
    },
  });

  const hex = withAlpha(hsvToHex(hsv), opacity);
  const opaque = hsvToHex(hsv);
  // Knob position: saturation along the radius, hue as the angle.
  const knobRadius = (hsv.s * WHEEL_SIZE) / 2;
  const knobAngle = (hsv.h * Math.PI) / 180;

  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = (text: string) => {
    const rgb = parseHex(text);
    setDraft(null);
    if (!rgb) return;
    // A typed 6-digit value means opaque; an 8-digit one carries its own alpha.
    // Either way the field is the authority, so the slider follows it.
    const next = rgbToHex(rgb.r, rgb.g, rgb.b, alpha ? rgb.a : 1);
    lastEmitted.current = next;
    setHsv(hexToHsv(next));
    setOpacity(alpha ? rgb.a : 1);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div
          ref={wheelRef}
          className="relative shrink-0 cursor-crosshair touch-none rounded-full"
          style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
          {...dragHandlers((x, y) => pickFromWheel(x, y))}
        >
          <canvas
            ref={canvasRef}
            className="block h-full w-full rounded-full"
            style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
          />
          {/* Two rings, light over dark, so the knob stays visible on any hue. */}
          <span
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/60 shadow-[0_0_0_1px_rgba(255,255,255,0.9)]"
            style={{
              left: WHEEL_SIZE / 2 + Math.cos(knobAngle) * knobRadius,
              top: WHEEL_SIZE / 2 - Math.sin(knobAngle) * knobRadius,
              background: hex,
            }}
          />
        </div>
        <div
          ref={barRef}
          className="relative h-[132px] w-5 shrink-0 cursor-ns-resize touch-none overflow-hidden rounded border border-border-primary/60"
          style={{ background: `linear-gradient(to bottom, ${hsvToHex({ ...hsv, v: 1 })}, #000000)` }}
          {...dragHandlers((_x, y) => pickFromBar(y))}
        >
          <span
            className="pointer-events-none absolute left-0 right-0 h-0.5 -translate-y-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
            style={{ top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>
      </div>
      {alpha && (
        <div className="flex items-center gap-2">
          <span className="w-11 shrink-0 text-[10px] text-text-secondary">Opacity</span>
          <div
            ref={alphaBarRef}
            className="relative h-4 flex-1 cursor-ew-resize touch-none overflow-hidden rounded border border-border-primary/60"
            // Checkerboard UNDER a transparent-to-opaque ramp of the chosen
            // colour, so the slider shows what the colour will actually do
            // rather than just a grey wedge.
            style={{ background: `linear-gradient(to right, transparent, ${opaque}), ${CHECKER}` }}
            {...dragHandlers((x) => pickFromAlphaBar(x))}
          >
            <span
              className="pointer-events-none absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
              style={{ left: `${opacity * 100}%` }}
            />
          </div>
          <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-text-secondary">
            {Math.round(opacity * 100)}%
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span
          className="h-5 w-5 shrink-0 rounded border border-border-primary/60"
          style={{ background: `linear-gradient(${hex}, ${hex}), ${CHECKER}` }}
        />
        <input
          type="text"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-border-primary bg-bg-secondary px-1.5 py-0.5 font-mono text-xs text-text-primary outline-none focus:border-brand-primary/40"
          value={draft ?? hex}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commitDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft((e.target as HTMLInputElement).value);
            // Escape here must not reach the viewer's global reset.
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      </div>
    </div>
  );
}
