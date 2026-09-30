/**
 * Scene background ("space colour"), including gradients.
 *
 * Done in CSS, on the viewer container, NOT as a three.js scene background —
 * because setupViewer sets `world.scene.three.background = null` and the WebGL
 * context is created with `alpha: true`, so the canvas composites over whatever
 * the DOM paints behind it. Measured, not assumed: a `#ffffff` container reads
 * back as pure white through the canvas, so the postproduction pass adds no
 * veil of its own. That makes an arbitrary CSS gradient free — a
 * `THREE.Texture` background would need a generated image per palette entry and
 * would then also be caught by the postprocessing passes.
 *
 * Each PRESET carries its own grid colour rather than deriving one from
 * luminance: the grid is a house-style symbol (CLAUDE.md §3 — convention
 * constant, not geometry truth), and the value that reads well against a
 * gradient depends on where the horizon sits, which a single luminance number
 * cannot express. A CUSTOM background has no hand-picked value to use, so there
 * the grid IS derived from luminance (`customBackground` below) — the one place
 * the fallback is the honest answer rather than a shortcut.
 */

import { Components } from "@thatopen/components";
import * as THREE from "three";

import { luminance } from "./color";
import { getGrid } from "./ProjectDetail/Viewer/grid-datum";

export interface SceneBackground {
  /** Persisted, so it must stay stable. */
  key: string;
  label: string;
  /** CSS `background` shorthand applied to the viewer container. */
  css: string;
  /** Grid line colour that stays legible against `css`. */
  gridHex: number;
  /**
   * The scene reads as light rather than dark. Consumers use it to keep their
   * own overlays legible; it is NOT used to derive the grid colour (see header).
   */
  isLight: boolean;
}

/**
 * Sky blue is one tone across the whole palette so the gradients read as
 * variations of one scene rather than four unrelated blues.
 */
const SKY = "#7ec8e3";
/** Deeper than the UI's own `--background-primary`, so a gradient bottom actually looks like a horizon fading out. */
const VOID_ = "#05070b";

export const SCENE_BACKGROUNDS: readonly SceneBackground[] = [
  {
    key: "sky-to-black",
    label: "Sky blue → black",
    css: `linear-gradient(180deg, ${SKY} 0%, #1d4a63 45%, ${VOID_} 100%)`,
    gridHex: 0x9fb6c4,
    isLight: false,
  },
  {
    key: "sky-to-white",
    label: "Sky blue → white",
    css: `linear-gradient(180deg, ${SKY} 0%, #c7e4f0 50%, #ffffff 100%)`,
    gridHex: 0x5f7c8c,
    isLight: true,
  },
  {
    key: "grey-to-black",
    label: "Grey → black",
    css: `linear-gradient(180deg, #7c848c 0%, #3a4046 45%, ${VOID_} 100%)`,
    gridHex: 0xb9c0c6,
    isLight: false,
  },
  {
    // The viewer's own pre-existing background, and the default: exactly
    // `--background-primary` from globals.css, so choosing it is
    // indistinguishable from never having touched the setting. Labelled as the
    // original rather than as "black" because it is not black — it is the very
    // dark navy the rest of the UI chrome is built on.
    key: "black",
    label: "Original",
    css: "rgb(14 20 32)",
    gridHex: 0x666666,
    isLight: false,
  },
  {
    key: "pure-black",
    label: "Pure black",
    css: "#000000",
    gridHex: 0x5c5c5c,
    isLight: false,
  },
  {
    key: "navy",
    label: "Dark navy",
    css: "#0a1a3c",
    gridHex: 0x6d7f9e,
    isLight: false,
  },
  {
    key: "white-to-sky",
    label: "White → sky blue",
    css: `linear-gradient(180deg, #ffffff 0%, #d6ecf5 50%, ${SKY} 100%)`,
    gridHex: 0x5f7c8c,
    isLight: true,
  },
  {
    key: "white-to-black",
    label: "White → black",
    css: `linear-gradient(180deg, #ffffff 0%, #7b8288 55%, ${VOID_} 100%)`,
    gridHex: 0x8e9498,
    isLight: true,
  },
] as const;

/** The palette entry that reproduces the pre-existing look. */
export const DEFAULT_SCENE_BACKGROUND_KEY = "black";

/** `key` of the entry built from the user's own two colours rather than a preset. */
export const CUSTOM_SCENE_BACKGROUND_KEY = "custom";

/**
 * A background the user mixed themselves: a top and a bottom colour. Two stops
 * rather than one, because every preset is a gradient and a single-colour
 * custom option would be a downgrade — setting both stops the same gives a flat
 * colour, so one control covers both cases.
 */
export interface CustomBackground {
  top: string;
  bottom: string;
}

export const DEFAULT_CUSTOM_BACKGROUND: CustomBackground = { top: "#7ec8e3", bottom: VOID_ };

/**
 * Grid colour for a custom background: push away from the mean brightness of
 * the two stops, hard enough to stay readable over the mid-gradient where the
 * two meet. Rec. 709 luma, not a channel average — see `luminance`.
 */
function derivedGridHex(background: CustomBackground): number {
  const mean = (luminance(background.top) + luminance(background.bottom)) / 2;
  return mean > 0.5 ? 0x555b60 : 0xb9c0c6;
}

export function customSceneBackground(background: CustomBackground): SceneBackground {
  const isLight = (luminance(background.top) + luminance(background.bottom)) / 2 > 0.5;
  return {
    key: CUSTOM_SCENE_BACKGROUND_KEY,
    label: "Custom",
    css: `linear-gradient(180deg, ${background.top} 0%, ${background.bottom} 100%)`,
    gridHex: derivedGridHex(background),
    isLight,
  };
}

/**
 * Resolve a stored key to something paintable. `custom` needs the stored pair
 * as well, which is why this takes it — an unknown key, or `custom` with no
 * pair saved, falls back to the default preset rather than to nothing.
 */
export const findSceneBackground = (
  key: string | null | undefined,
  custom?: CustomBackground | null,
): SceneBackground => {
  if (key === CUSTOM_SCENE_BACKGROUND_KEY) {
    return customSceneBackground(custom ?? DEFAULT_CUSTOM_BACKGROUND);
  }
  return (
    SCENE_BACKGROUNDS.find((b) => b.key === key) ??
    SCENE_BACKGROUNDS.find((b) => b.key === DEFAULT_SCENE_BACKGROUND_KEY)!
  );
};

/**
 * Paint `background` behind the canvas and re-colour the grid to match.
 *
 * `host` is the container the renderer's canvas lives in (`data-viewer-container`):
 * the canvas is a child, so the container's own background sits behind it.
 */
export function applySceneBackground(
  components: Components,
  host: HTMLElement | null,
  background: SceneBackground,
): void {
  if (host) host.style.background = background.css;
  const grid = getGrid(components);
  if (grid) {
    // Assigning the config setter (not the material uniform) so the value
    // survives the grid's own zoom-driven material updates.
    grid.config.color = new THREE.Color().setHex(background.gridHex);
  }
}
