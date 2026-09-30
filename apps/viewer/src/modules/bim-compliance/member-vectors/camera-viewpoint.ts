/**
 * Capture / restore the exact camera viewpoint of the viewer world.
 *
 * Used by the Connection Library: a saved connection returns the camera to
 * whatever vantage the user was looking from when they pressed Save — not a
 * generic fit-to-box of the members.
 *
 * Position + target alone fully define a PERSPECTIVE view (the position→target
 * distance is the framing). For an ORTHOGRAPHIC view the apparent size is the
 * camera's `zoom`, which is independent of that distance, so it is stored and
 * restored separately. Projection is captured too and switched first on
 * restore, before the look-at/zoom are applied to the (now correct) camera.
 *
 * All values are world coordinates, so a viewpoint stays valid whether or not
 * the model is isolated at restore time — the members sit at fixed world
 * positions either way.
 */
import { BoundingBoxer } from "@thatopen/components";
import type { Components, OrthoPerspectiveCamera } from "@thatopen/components";
import * as THREE from "three";

export interface CameraViewpoint {
  position: [number, number, number];
  target: [number, number, number];
  /** Active camera `.zoom` — the meaningful "how zoomed in" control for the orthographic projection. */
  zoom: number;
  projection: "Perspective" | "Orthographic";
}

/** Anything with a `camera` that is (duck-typed) an OrthoPerspectiveCamera. */
type WorldLike = { camera?: OrthoPerspectiveCamera } | null | undefined;

/** Snapshot the current camera vantage, or null if the world/camera isn't ready. */
export function captureViewpoint(world: WorldLike): CameraViewpoint | null {
  const cam = world?.camera;
  const ctr = cam?.controls;
  if (!cam || !ctr) return null;
  const p = ctr.getPosition(new THREE.Vector3());
  const t = ctr.getTarget(new THREE.Vector3());
  return {
    position: [p.x, p.y, p.z],
    target: [t.x, t.y, t.z],
    zoom: cam.three?.zoom ?? 1,
    projection: cam.projection?.current ?? "Perspective",
  };
}

/**
 * Move the camera to a saved viewpoint. Returns false (a no-op) if the world,
 * camera, or viewpoint is missing — callers use that to fall back to fit-to-box
 * for connections saved before viewpoints existed.
 */
export async function applyViewpoint(
  world: WorldLike,
  vp: CameraViewpoint | null | undefined,
  transition = true,
): Promise<boolean> {
  const cam = world?.camera;
  const ctr = cam?.controls;
  if (!cam || !ctr || !vp) return false;

  // Switch projection first so setLookAt/zoomTo act on the intended camera.
  if (cam.projection && vp.projection && cam.projection.current !== vp.projection) {
    await cam.projection.set(vp.projection).catch(() => undefined);
  }

  const moves: Promise<unknown>[] = [
    ctr.setLookAt(
      vp.position[0], vp.position[1], vp.position[2],
      vp.target[0], vp.target[1], vp.target[2],
      transition,
    ),
  ];
  // Ortho apparent size is `zoom`, not the position→target distance — restore
  // it in the same motion so the framing matches, not just the angle.
  if (vp.projection === "Orthographic" && Number.isFinite(vp.zoom)) {
    moves.push(ctr.zoomTo(vp.zoom, transition));
  }
  await Promise.all(moves).catch(() => undefined);
  return true;
}

/**
 * Straight top-down (plan) view framed on a set of members, with world +X to
 * the right of the screen. The fallback for connections saved before viewpoints
 * existed.
 *
 * `rotateTo(azimuth=0, polar=0)` is the deterministic straight-down orientation
 * — a purely vertical `setLookAt` is gimbal-locked. That convention puts world
 * +X on the RIGHT and world -Z at the TOP (see frameToFitTopDown in
 * ProjectDetail/Viewer/frame-to-fit.ts).
 */
export async function frameMembersTopDown(
  components: Components,
  world: WorldLike,
  modelIdMap: Record<string, Set<number>>,
  transition = true,
): Promise<boolean> {
  const controls = world?.camera?.controls;
  if (!controls) return false;
  const boundingBoxer = components.get(BoundingBoxer);
  try {
    boundingBoxer.list.clear();
    await boundingBoxer.addFromModelIdMap(modelIdMap);
    const box = boundingBoxer.get();
    boundingBoxer.list.clear();
    if (!box || box.isEmpty?.()) return false;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1);
    controls.moveTo(center.x, center.y, center.z, transition);
    controls.rotateTo(0, 0, transition);
    controls.dollyTo(extent * 1.6, transition);
    return true;
  } catch {
    boundingBoxer.list.clear();
    return false;
  }
}
