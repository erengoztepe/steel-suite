/**
 * A colour button that opens a list of named swatches.
 *
 * Shared by the two pickers in the top bar — the per-model tint on each file
 * chip and the scene background — because they are the same interaction and
 * differ only in their option list. The button face shows the CURRENT value
 * rather than an icon: with one of these per loaded file, the row itself has to
 * say which model is which colour without being opened.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface SwatchOption {
  key: string;
  label: string;
  /** CSS `background` for the preview chip — a colour or a gradient. */
  css: string;
}

interface SwatchPickerProps {
  options: readonly SwatchOption[];
  /** Selected key, or null for "not set" (only reachable when `clearLabel` is given). */
  value: string | null;
  onChange: (key: string | null) => void;
  /**
   * Label for the entry that returns to no explicit choice. Omitting it makes
   * the picker a required choice (the background always has one).
   */
  clearLabel?: string;
  /** Face shown while `value` is null. */
  clearCss?: string;
  title: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Which edge of the button the panel hangs from. */
  align?: "left" | "right";
  /**
   * Rendered under the option list, for a free colour picker. A slot rather
   * than a built-in "custom" mode because the two callers need different
   * editors — one colour for a model, a gradient's two stops for the background
   * — and this component stays the part they genuinely share.
   */
  footer?: ReactNode;
  /** Face shown when `value` matches no option (i.e. a custom colour is in use). */
  fallbackCss?: string;
}

export default function SwatchPicker({
  options,
  value,
  onChange,
  clearLabel,
  clearCss = "transparent",
  title,
  ariaLabel,
  disabled = false,
  align = "left",
  footer,
  fallbackCss,
}: SwatchPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  const selected = options.find((o) => o.key === value) ?? null;
  // A value with no matching option is a custom colour: show it rather than
  // falling through to the "unset" checkerboard, which would read as "no tint".
  const faceCss = selected ? selected.css : (value !== null ? fallbackCss : undefined) ?? null;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    // Capture phase + stopPropagation: Escape is ALSO the viewer's global
    // "reset everything" gesture (ControlPanel listens on window), and dismissing
    // a dropdown must not clear the user's selection as a side effect.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  return (
    <span ref={rootRef} className="relative shrink-0 leading-none">
      <button
        type="button"
        className="block h-4 w-4 rounded border border-border-primary/60 disabled:opacity-40"
        // The unset face is a checkerboard rather than a colour, so "no tint" is
        // not mistaken for "tinted white" — which is what the model already is.
        style={
          faceCss
            ? { background: faceCss }
            : {
                background: `${clearCss} repeating-conic-gradient(#ffffff40 0% 25%, #00000040 0% 50%) 50% / 6px 6px`,
              }
        }
        disabled={disabled}
        title={selected ? `${title}: ${selected.label}` : title}
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <span
          className={`absolute top-full z-40 mt-1 flex flex-col gap-0.5 rounded-lg border border-border-primary bg-bg-primary/95 p-1 shadow-lg backdrop-blur ${
            footer ? "w-52" : "w-44"
          }`}
          style={align === "right" ? { right: 0 } : { left: 0 }}
          role="menu"
        >
          {clearLabel && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === null}
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-bg-secondary ${
                value === null ? "text-text-primary" : "text-text-secondary"
              }`}
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border-primary/60"
                style={{
                  background: `${clearCss} repeating-conic-gradient(#ffffff40 0% 25%, #00000040 0% 50%) 50% / 6px 6px`,
                }}
              />
              <span className="truncate">{clearLabel}</span>
            </button>
          )}
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.key === value}
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-bg-secondary ${
                option.key === value ? "text-text-primary" : "text-text-secondary"
              }`}
              onClick={() => {
                onChange(option.key);
                close();
              }}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border-primary/60"
                style={{ background: option.css }}
              />
              <span className="truncate">{option.label}</span>
            </button>
          ))}
          {footer ? (
            <span className="mt-1 border-t border-border-primary/40 pt-1.5">{footer}</span>
          ) : null}
        </span>
      )}
    </span>
  );
}
