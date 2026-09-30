/**
 * Per-model colour: paint every element of ONE loaded file in a chosen colour,
 * so an assembly imported from several IFCs can be read apart at a glance.
 * Any colour, picked freely from a wheel, at any opacity — the presets below are
 * only shortcuts. Transparency is what lets one file's steel be read THROUGH
 * another's, which is the case a colour alone cannot cover.
 *
 * Mechanism — a Highlighter STYLE per model SLOT, not a direct
 * `model.highlight()` and not one style per colour:
 *
 * `Highlighter.updateColors()` opens with a GLOBAL `fragments.resetHighlight()`
 * and then re-paints only what its own `selection` map holds. So any colour
 * applied straight to a model (`model.highlight(undefined, def)`) survives
 * exactly until the next click — every select, clear and isolation runs
 * updateColors and wipes it. Registering the tint AS a highlighter style makes
 * the highlighter itself responsible for re-applying it, which is also what the
 * existing `red-highlight` overview does.
 *
 * Two ordering facts this depends on, both from the library source:
 *
 *  1. `updateColors` iterates `Object.entries(this.selection)` — i.e. the order
 *     the styles were REGISTERED — and later styles paint over earlier ones.
 *     Every tint slot is therefore registered before any other style (see
 *     `registerModelTintStyles`, called at the top of setupViewer's highlighter
 *     block) so that select / focus / red-highlight all still win over a tint.
 *     This is also why the slots are a FIXED set registered up front: a style
 *     created later, when the user picks a colour, would land after `select`
 *     and paint over the selection.
 *  2. For non-select styles updateColors uses `getMapWithoutSelection`, which
 *     subtracts the current selection. A selected element shows the select red
 *     over its tint, and drops back to the tint when deselected — no bookkeeping
 *     of ours required.
 *
 * A slot's colour is changed by re-`set`ting the style, whose only side effect
 * is emptying that style's selection — harmless here precisely because
 * `applyModelTints` re-derives every slot's membership from scratch on each
 * call anyway.
 */

import { Components, FragmentsManager } from "@thatopen/components";
import { Highlighter } from "@thatopen/components-front";
import { RenderedFaces } from "@thatopen/fragments";
import * as THREE from "three";

import { alphaOf, hexToInt, parseHex, rgbToHex } from "./color";

/** One preset swatch. Presets are shortcuts; the stored value is always a hex. */
export interface ModelTintPreset {
  label: string;
  hex: string;
}

/**
 * Suggested colours: pure white, whites pulled towards a hue, and a neutral
 * silver. Held at roughly equal lightness and low saturation so the HUE is what
 * tells two models apart rather than one just looking darker — and so a tint
 * stays clearly weaker than the colours that already MEAN something in this
 * viewer (red = selected, blue = focused, green/red = compliance).
 *
 * Not a closed set any more: the wheel reaches everything, and these are here
 * because picking a sensible neutral off a wheel is fiddly.
 */
export const MODEL_TINT_PRESETS: readonly ModelTintPreset[] = [
  { label: "Pure white", hex: "#ffffff" },
  { label: "Red-white", hex: "#f7d7d7" },
  { label: "Green-white", hex: "#d7f0d9" },
  { label: "Blue-white", hex: "#d7e3f7" },
  { label: "Orange-white", hex: "#f7e3cf" },
  { label: "Silver", hex: "#c9cccf" },
  { label: "Magenta-white", hex: "#f2d7ef" },
  { label: "Yellow-white", hex: "#f2eecb" },
  { label: "Cyan-white", hex: "#cfeff0" },
] as const;

/** The colour a custom pick starts from, when the model has no tint yet. */
export const DEFAULT_CUSTOM_TINT = "#d7e3f7";

/** modelId -> `#rrggbb` or `#rrggbbaa`. A model absent from the map keeps its original colours. */
export type TintAssignment = ReadonlyMap<string, string>;

const TINT_STYLE_PREFIX = "model-tint:";

/**
 * How many models can carry a tint at once. One style per slot, all registered
 * before anything else (see the header). Generous next to the handful of files
 * a single structure is ever split across; beyond it, the extra models simply
 * stay untinted rather than stealing another model's colour.
 */
const TINT_SLOTS = 12;

const slotStyleName = (slot: number) => `${TINT_STYLE_PREFIX}${slot}`;

/**
 * True for the styles this module owns. Callers that clear the highlighter
 * wholesale (Escape's reset-all) use this to leave the tints standing — a tint
 * is a property of the model, not a transient selection.
 */
export const isModelTintStyle = (styleName: string) => styleName.startsWith(TINT_STYLE_PREFIX);

/**
 * Colour keys persisted by earlier versions, when the palette was a closed set
 * of named entries. Read-only migration: a stored name resolves to the hex it
 * used to mean, and anything unrecognised is dropped rather than guessed.
 */
const LEGACY_TINT_KEYS: Record<string, string> = {
  white: "#ffffff",
  red: "#f7d7d7",
  green: "#d7f0d9",
  blue: "#d7e3f7",
  orange: "#f7e3cf",
  silver: "#c9cccf",
  magenta: "#f2d7ef",
  yellow: "#f2eecb",
  cyan: "#cfeff0",
  ivory: "#f7f0df",
  ice: "#e2edf8",
  pearl: "#e6e4e0",
  ash: "#a8adb2",
  stone: "#85888c",
  slate: "#5f666e",
};

/**
 * Normalise a stored value to `#rrggbb` / `#rrggbbaa`, or null if it means
 * nothing. Alpha is preserved — it is what makes a model see-through.
 */
export function resolveTintValue(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const rgb = parseHex(stored);
  if (rgb) return rgbToHex(rgb.r, rgb.g, rgb.b, rgb.a);
  return LEGACY_TINT_KEYS[stored] ?? null;
}

/**
 * The material definition for one tint colour.
 *
 * `renderedFaces` flips with transparency, and that is the whole reason this is
 * a function rather than an inline literal: at `ONE` only front faces are
 * drawn, which is right for a solid member but wrong the moment you can see
 * into it — the inside of a see-through beam would read as a hole where the
 * back faces should be. `TWO` costs nothing on the opaque path because the
 * opaque path never asks for it.
 */
function tintDefinition(hex: string) {
  const opacity = alphaOf(hex);
  const transparent = opacity < 1;
  return {
    color: new THREE.Color().setHex(hexToInt(hex)),
    renderedFaces: transparent ? RenderedFaces.TWO : RenderedFaces.ONE,
    opacity,
    transparent,
  };
}

/**
 * Register the tint slots.
 *
 * MUST run before `highlighter.setup()` and before any other `styles.set` —
 * registration order is paint order (see the file header). Idempotent.
 */
export function registerModelTintStyles(highlighter: Highlighter): void {
  for (let slot = 0; slot < TINT_SLOTS; slot++) {
    const name = slotStyleName(slot);
    // styles.onItemSet resets selection[name] to {}, so re-setting an existing
    // style would silently drop the model already tinted in that slot.
    if (highlighter.styles.has(name)) continue;
    highlighter.styles.set(name, {
      color: new THREE.Color(0xffffff),
      renderedFaces: RenderedFaces.ONE,
      opacity: 1,
      transparent: false,
    });
  }
}

/**
 * Local ids of the items that actually carry geometry, per model.
 *
 * Cached because the lookup is a worker round-trip over the whole model and the
 * answer cannot change for a given modelId: ids are never recycled (see
 * `uniqueModelId`), so a cache hit is always the right file. Entries for
 * unmounted models are pruned on the next apply.
 */
const geometryIds = new Map<string, number[]>();

/**
 * Make the viewer match `assignment` — the ONLY entry point, and declarative on
 * purpose: it re-derives every slot's colour AND membership from the assignment
 * rather than tracking add/remove/replace events, so load, import, unmount and
 * a colour change are all the same code path (the same reasoning as
 * `loadedModelIds` elsewhere in this app).
 *
 * Writes `highlighter.selection` directly and calls `updateColors()` ONCE.
 * Going through `clear()`/`highlightByID()` per style would be more idiomatic
 * but each of those calls updateColors itself — a full global reset and
 * re-paint of every highlight in the scene — so one colour change would pay for
 * it once per slot.
 */
export async function applyModelTints(components: Components, assignment: TintAssignment): Promise<void> {
  const highlighter = components.get(Highlighter);
  if (!highlighter.isSetup) return;
  const fragments = components.get(FragmentsManager);

  for (const modelId of [...geometryIds.keys()]) {
    if (!fragments.list.has(modelId)) geometryIds.delete(modelId);
  }

  // Resolve first, so slots are handed out only to entries that will really be
  // painted — otherwise an unmounted model would burn a slot and push a live
  // one past TINT_SLOTS.
  const paint: { modelId: string; hex: string; ids: number[] }[] = [];
  for (const [modelId, stored] of assignment) {
    if (paint.length >= TINT_SLOTS) break;
    const hex = resolveTintValue(stored);
    if (!hex) continue;
    const model = fragments.list.get(modelId);
    if (!model) continue;
    let ids = geometryIds.get(modelId);
    if (!ids) {
      ids = await model.getItemsIdsWithGeometry();
      geometryIds.set(modelId, ids);
    }
    if (ids.length === 0) continue;
    paint.push({ modelId, hex, ids });
  }

  for (let slot = 0; slot < TINT_SLOTS; slot++) {
    const name = slotStyleName(slot);
    const entry = paint[slot];
    if (entry) {
      // Re-`set` rather than mutating the stored definition in place: the
      // library builds its material from the definition it reads here, and only
      // a set is a documented way to change it. Its selection-wiping side
      // effect is why the selection is written immediately after.
      highlighter.styles.set(name, tintDefinition(entry.hex));
      highlighter.selection[name] = { [entry.modelId]: new Set(entry.ids) };
    } else if (highlighter.selection[name]) {
      // Reassignment, not deletion: keeping the key keeps this slot in its
      // registered position, and with it the paint order the whole mechanism
      // rests on.
      highlighter.selection[name] = {};
    }
  }

  await highlighter.updateColors();

  // Then re-stream the tiles, and NOT because the highlighter forgot to: it does
  // call `core.update(true)`, but it pushes that promise into the SAME array as
  // the highlight calls and awaits them together — so the re-stream can finish
  // before the highlight it was supposed to pick up. Measured consequence, at
  // the default (zoomed-out) camera where the model is drawn from streamed
  // tiles: the whole model disappears, because the tiles get rebuilt from the
  // pre-highlight state and nothing asks for them again. Awaiting an update
  // AFTER updateColors has settled is the whole fix.
  await fragments.core.update(true);
}
