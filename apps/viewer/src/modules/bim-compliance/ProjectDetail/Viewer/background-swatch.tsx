/**
 * The scene-background control: preset gradients, plus a two-stop mixer for
 * anything else.
 *
 * TWO stops, not one, because every preset is a gradient — a custom option that
 * only took a single colour would be the one choice that could not reproduce
 * what the presets already do. Setting both stops to the same colour gives a
 * flat background, so the one control covers both.
 */

import { useState } from "react";

import {
  CUSTOM_SCENE_BACKGROUND_KEY,
  customSceneBackground,
  DEFAULT_SCENE_BACKGROUND_KEY,
  SCENE_BACKGROUNDS,
  type CustomBackground,
} from "../../scene-background";
import ColorWheel from "./color-wheel";
import SwatchPicker from "./swatch-picker";

interface BackgroundSwatchProps {
  value: string;
  onChange: (key: string) => void;
  custom: CustomBackground;
  onCustomChange: (custom: CustomBackground) => void;
}

export default function BackgroundSwatch({
  value,
  onChange,
  custom,
  onCustomChange,
}: BackgroundSwatchProps) {
  const isCustom = value === CUSTOM_SCENE_BACKGROUND_KEY;
  const [editing, setEditing] = useState<"top" | "bottom" | null>(null);

  /**
   * Editing a stop also SELECTS the custom background — dragging a wheel while
   * a preset is still showing would give no feedback at all, and picking a
   * colour is unambiguously a request to use it.
   */
  const setStop = (stop: "top" | "bottom", hex: string) => {
    onCustomChange({ ...custom, [stop]: hex });
    if (!isCustom) onChange(CUSTOM_SCENE_BACKGROUND_KEY);
  };

  const preview = customSceneBackground(custom);

  return (
    <SwatchPicker
      options={[
        ...SCENE_BACKGROUNDS.map((b) => ({ key: b.key, label: b.label, css: b.css })),
        { key: CUSTOM_SCENE_BACKGROUND_KEY, label: "Custom", css: preview.css },
      ]}
      value={value}
      // No `clearLabel`, so the list is a required choice — the fallback is
      // unreachable and only there to satisfy the shared signature.
      onChange={(key) => onChange(key ?? DEFAULT_SCENE_BACKGROUND_KEY)}
      title="Background"
      ariaLabel="Choose the scene background"
      footer={
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1">
            {(["top", "bottom"] as const).map((stop) => (
              <button
                key={stop}
                type="button"
                className={`flex flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-bg-secondary ${
                  editing === stop ? "bg-bg-secondary text-text-primary" : "text-text-secondary"
                }`}
                aria-pressed={editing === stop}
                onClick={() => setEditing((prev) => (prev === stop ? null : stop))}
              >
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border-primary/60"
                  style={{ background: custom[stop] }}
                />
                <span className="truncate capitalize">{stop}</span>
              </button>
            ))}
          </span>
          {editing && (
            <ColorWheel value={custom[editing]} onChange={(hex) => setStop(editing, hex)} />
          )}
        </span>
      }
    />
  );
}
