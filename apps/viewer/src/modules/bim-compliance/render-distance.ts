/**
 * How much of the loaded model is actually drawn.
 *
 * Two independent limits cut geometry off, and both ship defaulted low:
 *
 *  1. **The camera far plane.** `OrthoPerspectiveCamera` fixes it at 1000 world
 *     units no matter what was loaded, while `frameToFit` already lets the user
 *     dolly out to `extent * MAX_DISTANCE_FACTOR` (8). Any model whose extent
 *     passes ~125 units can therefore be zoomed past its own far plane and get
 *     clipped away — and a file authored in millimetres blows through 1000
 *     before it is even framed. So the far plane is derived from the SAME extent
 *     that already bounds the dolly, rather than left as a constant.
 *
 *  2. **Fragments' LOD.** Under `LodMode.DEFAULT` with `graphicsQuality: 0`
 *     (both library defaults), anything not close to the camera is swapped for
 *     box placeholders — which is why a zoomed-out view shows a blocky
 *     approximation of the steelwork instead of the members. `ALL_GEOMETRY`
 *     keeps frustum culling (items outside the view stay hidden, so the saving
 *     that actually matters is kept) but draws everything in view at full
 *     detail.
 *
 * The LOD swap is also what made a per-model tint vanish: a highlight material
 * applies to real geometry, and the box placeholders carry their own LOD
 * material instead — so at a distance the tinted items were drawn by something
 * the tint never reached. Turning the placeholders off removes that whole class
 * of problem rather than working around it. See model-tint.ts.
 *
 * Both knobs are constants here, not UI: they are quality settings, and the
 * cost of `ALL_GEOMETRY` is triangles on very large files. If a huge model ever
 * needs the placeholders back, `LOD_MODE` is the single line to change.
 */

import {
  Components,
  FragmentsManager,
  type OrthoPerspectiveCamera,
  type SimpleScene,
  type SimpleWorld,
} from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";
import { LodMode } from "@thatopen/fragments";
import * as THREE from "three";

import { baseNearOf } from "./ProjectDetail/Viewer/adaptive-near";
import { computeModelsBox } from "./ProjectDetail/Viewer/frame-to-fit";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

/** 0 (boxes far away) .. 1 (full detail). */
const GRAPHICS_QUALITY = 1;

/** Full geometry for everything in view; out-of-view items still culled. */
const LOD_MODE = LodMode.ALL_GEOMETRY;

/**
 * Far plane as a multiple of the model's extent. Comfortably past
 * frame-to-fit's own `MAX_DISTANCE_FACTOR` (8) so the model stays whole at the
 * furthest the camera is allowed to go, plus room for the diagonal.
 */
const FAR_PLANE_FACTOR = 16;

/** Never go below the library's own default — small models keep their depth precision. */
const FAR_PLANE_FLOOR = 1000;

/**
 * Depth-buffer precision is set by the far/near RATIO, so an unbounded far plane
 * would z-fight the millimetre-scale detail this tool exists to look at. Capping
 * the ratio bounds `far` instead of raising `near`, because `near` is what
 * decides whether you can put the camera inside a connection — and the measure
 * tool owns it while armed (see use-measure-tool).
 */
const MAX_FAR_NEAR_RATIO = 50_000;

/**
 * Re-derive both limits from what is currently loaded. Idempotent, and safe to
 * call on every change to the model set (that is how it is wired: same
 * `loadedModelIds` signal as the grid datum).
 *
 * Returns the far plane it settled on, or null when there is nothing loaded to
 * measure — in which case the camera is left alone rather than reset.
 */
export function applyRenderDistance(components: Components, world: World | null): number | null {
  const fragments = components.get(FragmentsManager);

  // Global, so models loaded later start at full quality too.
  fragments.core.settings.graphicsQuality = GRAPHICS_QUALITY;
  for (const model of fragments.list.values()) {
    model.graphicsQuality = GRAPHICS_QUALITY;
    // Async, and nothing downstream depends on when it lands — the model
    // re-streams its tiles at the new detail level on its own.
    void model.setLodMode(LOD_MODE);
  }

  if (!world) return null;
  const box = computeModelsBox(components);
  if (box.isEmpty()) return null;

  // Diagonal, not the largest side: the camera is allowed to sit off-axis, so
  // the distance that has to stay inside the far plane is the corner-to-corner
  // one.
  const extent = box.getSize(new THREE.Vector3()).length();

  // BOTH cameras: OrthoPerspectiveCamera keeps a perspective and an orthographic
  // instance and swaps `three` between them, so setting only the active one
  // leaves the other clipping the moment the user hits the projection toggle.
  let applied: number | null = null;
  for (const camera of [world.camera.threePersp, world.camera.threeOrtho]) {
    if (!camera) continue;
    // Against the camera's BASE near, not the live one: the near plane follows
    // the orbit distance (adaptive-near.ts), and a far plane capped against
    // wherever the camera sat when this ran would stay cut short afterwards.
    const far = Math.min(
      Math.max(FAR_PLANE_FLOOR, extent * FAR_PLANE_FACTOR),
      baseNearOf(camera) * MAX_FAR_NEAR_RATIO,
    );
    applied = far;
    if (camera.far === far) continue;
    camera.far = far;
    camera.updateProjectionMatrix();
  }

  if (world.renderer) world.renderer.needsUpdate = true;
  return applied;
}
