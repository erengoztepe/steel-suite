import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";
import type * as THREE from "three";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

/**
 * The perspective camera's near plane follows how close the camera orbits.
 *
 * Left at OrthoPerspectiveCamera's fixed 1 m, everything within 1 m of the
 * camera is cut away, and the background shows through the cut. Isolation
 * frames a joint from a metre or two, so orbiting it sliced members open at
 * some angles and not others. Measured: a 1.75 m member framed from 1.49 m
 * came within 0.77 m of the camera on half of a full orbit.
 *
 * Near = orbit distance × NEAR_FACTOR, floored at NEAR_FLOOR and never above the
 * camera's own default, so a zoomed-out view keeps exactly the depth precision
 * it had. The measure tool narrows it further while armed; its "update" listener
 * is registered after this one, so it has the last word.
 */
const NEAR_FACTOR = 0.05;
const NEAR_FLOOR = 0.01;

/**
 * The camera's default near plane (its ceiling here). `render-distance` caps the
 * far plane against this rather than the live, distance-dependent value — so the
 * far plane doesn't depend on where the camera happened to be when it ran.
 */
export function baseNearOf(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): number {
  return (camera.userData.baseNear as number | undefined) ?? camera.near;
}

export function installAdaptiveNear(world: World): () => void {
  const controls = world.camera.controls;
  const perspective = world.camera.threePersp as THREE.PerspectiveCamera | undefined;
  if (!perspective) return () => undefined;
  perspective.userData.baseNear ??= perspective.near;
  const ceiling = perspective.userData.baseNear as number;

  const apply = () => {
    const camera = world.camera.three as THREE.PerspectiveCamera;
    if (!camera.isPerspectiveCamera) return;
    const near = Math.min(ceiling, Math.max(NEAR_FLOOR, controls.distance * NEAR_FACTOR));
    if (camera.near === near) return;
    camera.near = near;
    camera.updateProjectionMatrix();
    if (world.renderer) world.renderer.needsUpdate = true;
  };
  apply();
  controls.addEventListener("update", apply);
  return () => {
    controls.removeEventListener("update", apply);
    perspective.near = ceiling;
    perspective.updateProjectionMatrix();
  };
}
