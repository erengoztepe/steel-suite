import * as THREE from "three";
import { Components, FragmentsManager } from "@thatopen/components";
import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

// How far (relative to the model's own bounding-box extent) the camera is
// allowed to dolly out. Capping this relative to model scale — rather than
// an arbitrary fixed number — stops users from zooming out into empty space
// and losing the model, while still working across wildly different model sizes.
const MAX_DISTANCE_FACTOR = 8;

/**
 * Like `Box3.setFromObject`, but skips hidden subtrees.
 *
 * `Box3.expandByObject` (what `setFromObject` uses) recurses into every child
 * unconditionally — it has no visibility check at all, hidden or not. A model
 * hidden via its root `.object.visible = false` (see `toggleSourceVisibility`
 * in StandaloneApp) would still hold its full extent in the fit box, so the
 * camera would frame empty space reserved for geometry the user can't see.
 * `Object3D.traverseVisible` is the native three.js primitive that stops
 * descending once it hits an invisible node, which is exactly "what the
 * renderer would actually draw".
 *
 * Exported so the grid-datum aligner can reuse the exact same "what the
 * renderer draws" box (see grid-datum.ts).
 */
export function computeVisibleBox(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const localBox = new THREE.Box3();
  root.traverseVisible((node) => {
    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry;
    if (!geometry) return;
    let source = (node as unknown as { boundingBox?: THREE.Box3 | null }).boundingBox;
    if (!source) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      source = geometry.boundingBox;
    }
    if (!source) return;
    localBox.copy(source).applyMatrix4(node.matrixWorld);
    box.union(localBox);
  });
  return box;
}

/**
 * Union of the visible bounding boxes of the LOADED MODELS only — deliberately
 * NOT `world.scene`, which also carries tool overlays. Two reasons, both measured
 * rather than assumed:
 *
 *   - Overlays lie about the extent. Every clipping plane parks an invisible
 *     100000x100000 `TransformControlsPlane` (its MATERIAL is invisible, its
 *     object is not, so `traverseVisible` walks straight into it) in the scene.
 *     With one plane on, the scene box measured ~96000 units against a 144-unit
 *     model — which is exactly what sent the triple-click recovery, and the
 *     `maxDistance` cap with it, off into empty space.
 *   - The clipping-plane outline is sized from camera distance, so feeding it
 *     back into a camera fit would be a loop: farther camera -> bigger outline
 *     -> bigger box -> farther camera.
 *
 * Whole models hidden via `object.visible = false` (the source-visibility
 * toggle) are skipped, matching what the renderer actually draws.
 */
export function computeModelsBox(components: Components): THREE.Box3 {
  const fragments = components.get(FragmentsManager);
  const box = new THREE.Box3();
  for (const [, model] of fragments.list) {
    const object = (model as { object?: THREE.Object3D }).object;
    if (!object || !object.visible) continue;
    const modelBox = computeVisibleBox(object);
    if (!modelBox.isEmpty()) box.union(modelBox);
  }
  return box;
}

function computeBounds(world: World): { center: THREE.Vector3; extent: number } | null {
  const box = computeModelsBox(world.components);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1);
  return { center, extent };
}

/**
 * Frames the camera on the loaded models (center + fit distance) and caps max
 * zoom-out relative to the model's size. Used both for the initial IFC load and
 * to recover when a user has scrolled/panned away from the model.
 */
export function frameToFit(world: World, enableTransition = true): boolean {
  const bounds = computeBounds(world);
  if (!bounds) return false;
  const { center, extent } = bounds;
  const d = extent * 1.6;

  world.camera.controls.maxDistance = extent * MAX_DISTANCE_FACTOR;
  world.camera.controls.setLookAt(
    center.x + d,
    center.y + d * 0.7,
    center.z + d,
    center.x,
    center.y,
    center.z,
    enableTransition,
  );
  return true;
}

/**
 * Fit now, then again a few times over the next couple of seconds.
 *
 * Fragment geometry streams in AFTER `core.load` resolves, so a fit fired the
 * instant a load finishes measures a model that is barely there — measured on the
 * bundled default: a single fit landed on a 2-unit box (the grid, before any
 * geometry existed) and left `maxDistance` at 16 on a 144-unit model, i.e. the
 * user could not zoom out past twice the model. Same failure and same remedy as
 * `alignGridWhenReady` in grid-datum.ts.
 *
 * Only re-fits while the measured extent is still GROWING: once streaming has
 * settled the camera is left alone, so a late tick can never yank a view the user
 * has already started navigating. Returns a canceller.
 */
export function frameToFitWhenReady(world: World, enableTransition = true): () => void {
  const delays = [0, 150, 400, 800, 1500, 2500];
  let cancelled = false;
  let lastExtent = 0;
  const timers = delays.map((d) =>
    setTimeout(() => {
      if (cancelled) return;
      const bounds = computeBounds(world);
      if (!bounds || bounds.extent <= lastExtent) return;
      lastExtent = bounds.extent;
      frameToFit(world, enableTransition);
    }, d),
  );
  return () => {
    cancelled = true;
    timers.forEach((t) => clearTimeout(t));
  };
}

/**
 * Recovery framing: whole model, straight top-down (plan) view. Uses
 * `rotateTo(azimuth, polar)` with ABSOLUTE angles (0, 0) rather than
 * `setLookAt`'s implicit look-at math, because a purely vertical `setLookAt`
 * leaves the camera's roll/azimuth undefined (any horizontal rotation looks
 * "straight down" — it's a gimbal-lock case) and would just preserve whatever
 * azimuth the camera happened to have before recovering. `rotateTo(0, 0, …)`
 * is deterministic regardless of prior orientation.
 *
 * Empirically verified (camera-controls' azimuth/polar convention isn't
 * documented precisely enough to derive this by hand): azimuth=0, polar=0
 * puts world -X (assumed "west") on the LEFT of the screen and world -Z at
 * the TOP — matching the Navisworks-style plan-view orientation requested.
 */
export function frameToFitTopDown(world: World, enableTransition = true): boolean {
  const bounds = computeBounds(world);
  if (!bounds) return false;
  const { center, extent } = bounds;
  const d = extent * 1.6;

  const controls = world.camera.controls;
  controls.maxDistance = extent * MAX_DISTANCE_FACTOR;
  controls.moveTo(center.x, center.y, center.z, enableTransition);
  controls.rotateTo(0, 0, enableTransition);
  controls.dollyTo(d, enableTransition);
  return true;
}
