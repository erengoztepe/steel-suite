/**
 * Ground-grid datum: keep the reference grid at the foot of whatever is loaded.
 *
 * The grid ThatOpen creates in `setupViewer` lives at world Y=0, which has no
 * relationship to where a given IFC's geometry actually sits — each file places
 * its own origin, so a fixed Y=0 grid lands in an arbitrary spot (famously
 * BETWEEN a roof model and the structure below it when the two are imported together). The
 * fix is to snap the grid to the bottom of the combined model box on every load,
 * import, unmount and visibility change (wired declaratively in StandaloneApp).
 *
 * The grid's own shader draws the plane at the mesh's model-matrix Y — its
 * vertex shader multiplies `pos` by `modelViewMatrix`, so moving
 * `grid.three.position.y` genuinely moves the visible grid (the `.xz` follows
 * the camera on its own). Verified against the shader source, not assumed.
 */

import {
  Components,
  Grids,
  type OrthoPerspectiveCamera,
  type SimpleGrid,
  type SimpleScene,
  type SimpleWorld,
} from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";

import { computeModelsBox } from "./frame-to-fit";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

/** The single grid this viewer creates (one world -> one grid, keyed by world uuid). */
export function getGrid(components: Components): SimpleGrid | null {
  const first = components.get(Grids).list.values().next();
  return first.done ? null : first.value;
}

/**
 * Snap the ground grid to the bottom of everything currently loaded and visible.
 * Returns the new datum Y, or null when there is nothing to align to (grid or
 * geometry missing) — the grid is then left where it is rather than jumping to 0.
 *
 * `computeModelsBox` (models only, never the scene) is load-bearing here beyond
 * its own reasons: unioning the grid's own 2x2 box would pin the datum to
 * wherever the grid already sits — a feedback loop that would freeze it.
 */
export function alignGridToModels(components: Components, world: World | null): number | null {
  const grid = getGrid(components);
  if (!grid) return null;
  const box = computeModelsBox(components);
  if (box.isEmpty()) return null;
  const y = box.min.y;
  grid.three.position.y = y;
  grid.three.updateMatrixWorld(true);
  if (world?.renderer) world.renderer.needsUpdate = true;
  return y;
}

/**
 * Align now, then again a few times over the next couple of seconds.
 *
 * Fragment geometry streams in AFTER `core.load` resolves — so an align fired
 * the instant the model set changes sees an empty/partial box and no-ops (this
 * is exactly why a single load-time align left the grid stranded at Y=0). Re-
 * running on a short schedule lets the box fill in; each tick just re-snaps to
 * the current bottom, so the last non-empty tick lands on the final value.
 * `setTimeout` (not `requestAnimationFrame`) so it still fires when the tab
 * isn't compositing. Returns a canceller for effect cleanup.
 */
export function alignGridWhenReady(components: Components, world: World | null): () => void {
  const delays = [0, 150, 400, 800, 1500, 2500];
  const timers = delays.map((d) => setTimeout(() => alignGridToModels(components, world), d));
  return () => timers.forEach((t) => clearTimeout(t));
}

/** Toggle grid visibility; returns the new visible state. */
export function toggleGridVisible(components: Components, world: World | null): boolean {
  const grid = getGrid(components);
  if (!grid) return false;
  grid.visible = !grid.visible;
  // On-demand renderer: flipping a flag on the already-drawn grid moves no
  // camera, so nothing repaints without this.
  if (world?.renderer) world.renderer.needsUpdate = true;
  return grid.visible;
}

/** Whether the grid is currently visible (false when there is no grid yet). */
export function isGridVisible(components: Components): boolean {
  return getGrid(components)?.visible ?? false;
}

/**
 * Nudge the grid up (+1) or down (-1) by a fraction of the model's vertical
 * extent, so a click feels the same whether the model is a 3 m detail or a
 * 300 m building. A manual nudge persists during normal viewing; the next load
 * or visibility change re-runs the auto-align and resets it.
 */
export function nudgeGrid(components: Components, world: World | null, direction: 1 | -1): void {
  const grid = getGrid(components);
  if (!grid) return;
  const box = computeModelsBox(components);
  const extent = box.isEmpty() ? 1 : Math.max(box.max.y - box.min.y, 1);
  const step = Math.max(extent * 0.02, 0.1);
  grid.three.position.y += direction * step;
  grid.three.updateMatrixWorld(true);
  if (world?.renderer) world.renderer.needsUpdate = true;
}
