/**
 * The per-model colour control on a file chip: preset swatches, plus a wheel
 * for anything else.
 *
 * The custom section is collapsed behind a toggle rather than always shown. The
 * common case is "give this file a colour I can tell apart", which the presets
 * answer in one click; opening a wheel every time would put a 130 px canvas in
 * the way of that.
 */

import { useState } from "react";

import { DEFAULT_CUSTOM_TINT, MODEL_TINT_PRESETS, resolveTintValue } from "../../model-tint";
import ColorWheel from "./color-wheel";
import SwatchPicker from "./swatch-picker";

interface TintSwatchProps {
  /** Stored colour for this file, or null when it keeps its original colours. */
  value: string | null;
  onChange: (hex: string | null) => void;
  fileName: string;
  disabled?: boolean;
}

export default function TintSwatch({ value, onChange, fileName, disabled = false }: TintSwatchProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const resolved = resolveTintValue(value);
  const isPreset = MODEL_TINT_PRESETS.some((p) => p.hex === resolved);
  // Over a checkerboard, so a see-through tint reads as see-through on the chip
  // rather than as a washed-out flat colour.
  const faceCss = resolved
    ? `linear-gradient(${resolved}, ${resolved}), repeating-conic-gradient(#ffffff40 0% 25%, #00000040 0% 50%) 50% / 6px 6px`
    : undefined;

  return (
    <SwatchPicker
      // Keyed by hex, so a preset and the same colour picked off the wheel are
      // the same value — no way to end up with two representations of one colour.
      options={MODEL_TINT_PRESETS.map((p) => ({ key: p.hex, label: p.label, css: p.hex }))}
      value={resolved}
      onChange={(key) => onChange(key)}
      clearLabel="Original colours"
      fallbackCss={faceCss}
      title={`${fileName} — colour`}
      ariaLabel={`Choose a colour for ${fileName}`}
      disabled={disabled}
      footer={
        <span className="flex flex-col gap-1.5">
          <button
            type="button"
            className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-bg-secondary ${
              resolved && !isPreset ? "text-text-primary" : "text-text-secondary"
            }`}
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
          >
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border-primary/60"
              // A hue ring, so the row reads as "any colour" rather than as one more swatch.
              style={{
                background:
                  "conic-gradient(#ff4d4d, #ffe14d, #4dff88, #4de1ff, #4d6bff, #e14dff, #ff4d4d)",
              }}
            />
            <span className="truncate">Custom colour…</span>
          </button>
          {customOpen && (
            <ColorWheel
              value={resolved ?? DEFAULT_CUSTOM_TINT}
              onChange={(hex) => onChange(hex)}
              // Only here: a model can be see-through, and that is what makes one
              // file's steel readable through another's. The scene background has
              // no alpha to give — it composites onto the UI's own ground colour,
              // so a slider there would only mute the colour the user picked.
              alpha
            />
          )}
        </span>
      }
    />
  );
}
