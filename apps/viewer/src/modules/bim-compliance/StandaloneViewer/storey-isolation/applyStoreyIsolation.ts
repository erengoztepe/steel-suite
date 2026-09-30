import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import {
  BoundingBoxer,
  Components,
  FragmentsManager,
} from "@thatopen/components";
import type { PostproductionRenderer } from "@thatopen/components-front";
import type { MutableRefObject } from "react";
import * as THREE from "three";

import { frameIsolatedMembers } from "./isolation-framing";
import { captureCameraPose, pushInPose, runIsolationTransition, type CameraPose } from "./isolation-transition";

/**
 * The camera lands this fraction of its distance closer to the target than the
 * framing's default distance (same angle), in the same glide — not as a second
 * move after it. 0 = none; negative pulls back (-0.3 = 30 % farther). On trial
 * now that the framing targets the joint itself.
 */
export const ISOLATION_PUSH_IN = -0.45;

/** The isolation view's fixed angle: from the +X/+Z diagonal, ~47° above horizontal (Y up). */
const VIEW_DIRECTION = new THREE.Vector3(0.4, 0.6, 0.4).normalize();

export type StoreyIsolationWorldRef = MutableRefObject<
  SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer> | null
>;

export interface IsolationOptions {
  /**
   * Animate instead of switching in one frame: the members outside the
   * selection fade over this many ms (and, when isolating, the camera glides to
   * the fit over the same clock). Omitted = the old instant behaviour.
   */
  transitionMs?: number;
  /** With `transitionMs`: called on the frame the fade starts (see `onRampStart`). */
  onFadeStart?: () => void;
}

export async function clearStoreyIsolation(
  components: Components,
  worldRef?: StoreyIsolationWorldRef,
  options: IsolationOptions = {},
): Promise<void> {
  try {
    const fragmentsManager = components.get(FragmentsManager);
    if (!fragmentsManager.initialized) {
      return;
    }
    // The selection highlight is deliberately KEPT: leaving isolation must not
    // un-paint the members — they stay red so the viewer returns to the exact
    // pre-Extract&Isolate state (see member-vectors handleClose).
    // Visibility calls only: the animated path brings them into the scene with
    // `forceFragmentsUpdate`, the instant one with the plain update below.
    const reveal = async () => {
      for (const model of fragmentsManager.list.values()) {
        await model.resetVisible();
      }
    };
    const world = worldRef?.current;
    if (options.transitionMs && world?.camera) {
      await runIsolationTransition(components, world, {
        direction: "in",
        durationMs: options.transitionMs,
        whileInvisible: reveal,
        onRampStart: options.onFadeStart,
      });
    } else {
      await reveal();
      await fragmentsManager.core.update(true);
    }
    // The PostproductionRenderer paints on demand (only when `needsUpdate` is
    // set — normally by a camera control event). Un-hiding the fragments doesn't
    // move the camera, so without this flag the model stays visually isolated
    // until the user next pans/zooms/selects. Restoring visibility is just a
    // flag flip on already-loaded geometry, so one repaint is enough.
    const renderer = worldRef?.current?.renderer;
    if (renderer) renderer.needsUpdate = true;
  } catch {
    // Fragments / highlighter may be unavailable during viewer setup or teardown
  }
}

/**
 * Hides all fragment instances not in `visibleByModel` and fits the perspective
 * camera. The selection highlight is KEPT — the isolated members stay painted
 * (red) rather than turning plain while isolated.
 *
 * With `transitionMs` the hide is a fade and the fit is a glide, both on one
 * clock, and camera input is locked until they land (isolation-transition.ts).
 */
export async function applyStoreyIsolation(
  components: Components,
  worldRef: StoreyIsolationWorldRef,
  visibleByModel: Record<string, Set<number>>,
  options: IsolationOptions = {},
): Promise<void> {
  const fragmentsManager = components.get(FragmentsManager);
  if (!fragmentsManager.initialized) {
    return;
  }
  for (const model of fragmentsManager.list.values()) {
    await model.resetVisible();
  }

  const hideByModel = new Map<string, number[]>();
  for (const [modelId, model] of fragmentsManager.list) {
    const visible = visibleByModel[modelId] ?? new Set<number>();

    let allIds: number[] = [];
    try {
      const local = await model.getLocalIds();
      if (Array.isArray(local)) {
        allIds = local;
      } else if (local != null && typeof (local as ArrayLike<number>).length === "number") {
        allIds = Array.from(local as ArrayLike<number>);
      }
    } catch {
      continue;
    }

    const toHide = visible.size === 0 ? allIds : allIds.filter((id) => !visible.has(id));
    if (toHide.length > 0) hideByModel.set(modelId, toHide);
  }

  // Visibility calls only — see `reveal` in clearStoreyIsolation.
  const hide = async () => {
    for (const [modelId, toHide] of hideByModel) {
      await fragmentsManager.list.get(modelId)?.setVisible(toHide, false);
    }
  };

  const world = worldRef.current;
  const animate = !!options.transitionMs && !!world?.camera;
  if (!animate) {
    await hide();
    await fragmentsManager.core.update(true);
  }
  if (!world?.camera) return;

  const cam = world.camera as OrthoPerspectiveCamera & {
    projection?: { set?: (mode: string) => void };
  };
  cam.projection?.set?.("Perspective");

  const fit = await computeIsolationFit(components, visibleByModel);
  const close = fit ? pushInPose(fit, ISOLATION_PUSH_IN) : null;
  if (!animate) {
    if (close) {
      world.camera.controls.setLookAt(
        close.position.x, close.position.y, close.position.z,
        close.target.x, close.target.y, close.target.z,
        true,
      );
    }
    return;
  }

  await runIsolationTransition(components, world, {
    direction: "out",
    durationMs: options.transitionMs,
    camera: close ? { from: captureCameraPose(world), to: close } : undefined,
    whileInvisible: hide,
    onRampStart: options.onFadeStart,
  });
}

/**
 * Camera pose framing the isolated members (see isolation-framing.ts), or null
 * if they have no geometry. Falls back to the members' world box — same
 * distance rule, box centre as target — if their mesh can't be read.
 */
async function computeIsolationFit(
  components: Components,
  visibleByModel: Record<string, Set<number>>,
): Promise<CameraPose | null> {
  const modelIdMapForBox: Record<string, Set<number>> = {};
  for (const [mid, set] of Object.entries(visibleByModel)) {
    if (set.size > 0) modelIdMapForBox[mid] = set;
  }
  if (Object.keys(modelIdMapForBox).length === 0) return null;

  try {
    const framing = await frameIsolatedMembers(components, modelIdMapForBox);
    if (framing) return poseLookingAt(framing.target, framing.distance);
  } catch (e) {
    console.warn("[storey-isolation] joint framing failed, using the members' box:", e);
  }

  try {
    const boundingBoxer = components.get(BoundingBoxer);
    boundingBoxer.list.clear();
    await boundingBoxer.addFromModelIdMap(modelIdMapForBox);
    const box = boundingBoxer.get();
    boundingBoxer.list.clear();
    if (box.isEmpty?.()) return null;

    const size = box.getSize(new THREE.Vector3());
    const edges = [size.x, size.y, size.z];
    const distance = Math.max((Math.min(...edges) + Math.max(...edges)) / 2, 0.5);
    return poseLookingAt(box.getCenter(new THREE.Vector3()), distance);
  } catch (e) {
    console.warn("[storey-isolation] camera fit failed:", e);
    return null;
  }
}

function poseLookingAt(target: THREE.Vector3, distance: number): CameraPose {
  return { position: target.clone().addScaledVector(VIEW_DIRECTION, distance), target: target.clone() };
}
