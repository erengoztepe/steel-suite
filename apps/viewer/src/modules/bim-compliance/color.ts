/**
 * Colour helpers shared by the pickers and by whatever has to react to a
 * chosen colour (grid contrast, swatch previews).
 *
 * HSV rather than HSL because that is what a colour wheel plus a brightness bar
 * actually is: the wheel is hue (angle) and saturation (radius), the bar is
 * value. HSL's lightness axis would make the wheel's rim change colour as the
 * bar moves, which is not how the control reads.
 *
 * Everything crosses module boundaries as a hex string: `#rrggbb`, or `#rrggbbaa`
 * when it carries transparency. It is what CSS takes, what `THREE.Color` takes
 * once the alpha is split off, and what survives being written to localStorage
 * and read back. Opaque values stay 6-digit so nothing that only understands
 * `#rrggbb` has to change.
 */

export interface Hsv {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * `#rrggbb`, lower case — or `#rrggbbaa` when `alpha` is given and below 1.
 * Accepts channels as 0..255 floats.
 */
export function rgbToHex(r: number, g: number, b: number, alpha = 1): string {
  const to = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${to(r)}${to(g)}${to(b)}`;
  return alpha >= 1 ? base : `${base}${to(clamp01(alpha) * 255)}`;
}

/**
 * Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or the bare forms. Alpha defaults to 1
 * when the string does not carry one. Returns null for anything else — callers
 * decide what to do, since a half-typed value in a text field is normal rather
 * than exceptional.
 */
export function parseHex(input: string): { r: number; g: number; b: number; a: number } | null {
  const hex = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1,
    };
  }
  if (/^[0-9a-f]{6}$/i.test(hex) || /^[0-9a-f]{8}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** Alpha of a hex colour, 0..1. 1 for anything without an alpha pair. */
export function alphaOf(hex: string): number {
  return parseHex(hex)?.a ?? 1;
}

/**
 * Same colour, different alpha. Emits 6 digits at alpha 1 so an opaque value is
 * byte-identical to what the presets and older stored values look like.
 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return rgbToHex(rgb.r, rgb.g, rgb.b, alpha);
}

/** Drop any alpha — for the places that need a plain `THREE.Color` input. */
export function opaqueHex(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const sat = clamp01(s);
  const val = clamp01(v);
  const hue = ((h % 360) + 360) % 360;
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[sector];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function hexToHsv(hex: string): Hsv {
  const rgb = parseHex(hex);
  if (!rgb) return { h: 0, s: 0, v: 1 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Perceived brightness, 0..1 — the Rec. 709 luma weights, not a channel
 * average: green reads far brighter than blue at the same numeric value, so an
 * average would call a saturated blue "light" and put a dark grid on it.
 *
 * Used to decide what has to stay legible ON a colour the user chose freely,
 * which is the case the hand-picked preset values cannot cover.
 */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/** `#rrggbb` -> the 0xrrggbb number `THREE.Color.setHex` wants. */
export function hexToInt(hex: string): number {
  // Alpha deliberately dropped: THREE.Color has no alpha channel, and the
  // opacity it pairs with lives on the material instead.
  const rgb = parseHex(hex);
  if (!rgb) return 0xffffff;
  return (rgb.r << 16) | (rgb.g << 8) | rgb.b;
}
