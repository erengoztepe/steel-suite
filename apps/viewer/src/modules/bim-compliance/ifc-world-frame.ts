/**
 * The world frame a file's coordinates are expressed in — read straight from the
 * raw IFC, so two files can be checked for placing the same structure the same
 * way before their geometry is combined.
 *
 * Why this matters when importing: the extractors re-open each original IFC and
 * report coordinates in THAT FILE's own world frame (the placement chain
 * composed up to its spatial root). Parts exported from one project share that
 * frame, so their coordinates are directly comparable and a joint spanning two
 * files solves correctly. Parts exported with different origins do NOT — one
 * file georeferenced (this repo's own sample model sits at 632 km / 2 720 km)
 * and the other local to the structure would put the same physical joint
 * kilometres apart, and the joint solver would happily return plausible-looking
 * garbage for it.
 *
 * The viewer itself is not the tell: fragments' `autoCoordinate` aligns each
 * loaded model to the first one's frame, so mismatched files can look perfectly
 * seated on screen while the extracted numbers behind them disagree. So the
 * check is made on the bytes, and a mismatch is REPORTED rather than silently
 * corrected — the correcting transform would be an unverified guess about which
 * file is authoritative, and this project treats that kind of inference as worse
 * debt than a plain gap.
 */

import { IfcAPI, IFCBUILDING, IFCSITE } from "web-ifc";

import { getLocalPlacement, WASM_PATH, type Mat4 } from "./member-vectors/ifc-core";

export interface IfcWorldFrame {
  /** Composed origin (file units) of the topmost spatial element's placement. */
  origin: [number, number, number];
  /** That placement's rotation part, row-major 3x3 flattened — compared separately from the origin. */
  rotation: number[];
  /** Which entity the frame was read from, for the diagnostic message. */
  readFrom: "IfcSite" | "IfcBuilding" | "none";
}

function frameFromMatrix(m: Mat4, readFrom: IfcWorldFrame["readFrom"]): IfcWorldFrame {
  return {
    origin: [m[3], m[7], m[11]],
    rotation: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
    readFrom,
  };
}

function firstPlacementOfType(api: IfcAPI, modelID: number, type: number): Mat4 | null {
  let idList: any;
  try {
    idList = api.GetLineIDsWithType(modelID, type);
  } catch {
    return null;
  }
  const count = Array.isArray(idList) ? idList.length : idList?.size?.() ?? 0;
  for (let i = 0; i < count; i++) {
    const id = Array.isArray(idList) ? idList[i] : idList.get(i);
    let element: any;
    try {
      element = api.GetLine(modelID, id);
    } catch {
      continue;
    }
    if (!element?.ObjectPlacement) continue;
    return getLocalPlacement(api, modelID, element.ObjectPlacement);
  }
  return null;
}

/** Read a file's world frame from its spatial root. Opens and closes its own web-ifc model. */
export async function readWorldFrame(bytes: Uint8Array): Promise<IfcWorldFrame> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    const site = firstPlacementOfType(api, modelID, IFCSITE);
    if (site) return frameFromMatrix(site, "IfcSite");
    const building = firstPlacementOfType(api, modelID, IFCBUILDING);
    if (building) return frameFromMatrix(building, "IfcBuilding");
    return { origin: [0, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], readFrom: "none" };
  } finally {
    api.CloseModel(modelID);
  }
}

/**
 * How far apart two files place their structures. `originDeltaMm` is the
 * straight-line distance between the two frames' origins; `rotationDiffers` is
 * true when the frames are also turned relative to each other (true north /
 * project rotation), which an origin distance alone would miss.
 */
export function compareWorldFrames(
  base: IfcWorldFrame,
  other: IfcWorldFrame,
): { originDeltaMm: number; rotationDiffers: boolean; matches: boolean } {
  const originDeltaMm = Math.hypot(
    other.origin[0] - base.origin[0],
    other.origin[1] - base.origin[1],
    other.origin[2] - base.origin[2],
  );
  // 1e-3 on direction cosines ≈ 0.06° — below any real project rotation and
  // well above the float noise of composing a placement chain.
  const rotationDiffers = base.rotation.some((v, i) => Math.abs(v - other.rotation[i]) > 1e-3);
  // 1 mm: the same origin written by two exports of one project can differ in
  // the last decimal, but nothing meaningful is under a millimetre here.
  return { originDeltaMm, rotationDiffers, matches: originDeltaMm <= 1 && !rotationDiffers };
}
