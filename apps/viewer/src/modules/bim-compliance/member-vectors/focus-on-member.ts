/**
 * Moves the viewer camera to frame a single already-resolved member — used by
 * the "go to tag" lookup so a specific element can be visually inspected
 * without hunting for it in the model (e.g. cross-checking an Alfa/rotation
 * QA case reported by tag number).
 */

import { BoundingBoxer, Components, type SimpleWorld } from "@thatopen/components";
import * as THREE from "three";

/** How much extra room (relative to the member's own box) to leave around it. */
const PADDING_FACTOR = 0.6;

export async function focusOnMember(
  components: Components,
  world: SimpleWorld | null,
  modelId: string,
  localId: number,
): Promise<boolean> {
  if (!world?.camera?.controls) return false;

  const boundingBoxer = components.get(BoundingBoxer);
  try {
    boundingBoxer.list.clear();
    await boundingBoxer.addFromModelIdMap({ [modelId]: new Set([localId]) });
    const box = boundingBoxer.get();
    boundingBoxer.list.clear();
    if (box.isEmpty?.()) return false;

    const size = box.getSize(new THREE.Vector3());
    const pad = Math.max(size.x, size.y, size.z, 1) * PADDING_FACTOR;
    await world.camera.controls.fitToBox(box, true, {
      paddingLeft: pad,
      paddingRight: pad,
      paddingTop: pad,
      paddingBottom: pad,
    });
    return true;
  } catch {
    boundingBoxer.list.clear();
    return false;
  }
}
