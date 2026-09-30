/**
 * Node-centric selection: given one member, find every other beam/column that
 * shares an endpoint with it (a structural joint), within a distance
 * tolerance. Lets the user click one member at a joint instead of
 * shift-clicking every member that meets there.
 */

import { IfcAPI } from "web-ifc";

import { extractAllMemberEndpoints, type MemberEndpoints } from "./extract-member-vectors";

/** web-ifc WASM, copied to /public/wasm/web-ifc/ at build time (same as GeometryEngine). */
const WASM_PATH = "/wasm/web-ifc/";

/** Default joint-matching tolerance (mm) — accounts for minor modeling gaps at a shared node. */
export const DEFAULT_JOINT_TOLERANCE_MM = 50;

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Finds all members (excluding the target) whose start or end point lies
 * within `toleranceMm` of either end of the target member. Returns their
 * GlobalIds in no particular order — the caller decides how to merge them
 * into an existing ordered selection.
 */
export function findConnectedMembers(
  endpoints: MemberEndpoints[],
  targetGlobalId: string,
  toleranceMm: number = DEFAULT_JOINT_TOLERANCE_MM,
): string[] {
  const target = endpoints.find((e) => e.globalId === targetGlobalId);
  if (!target) return [];

  const targetPoints = [target.start, target.end];
  const found: string[] = [];

  for (const el of endpoints) {
    if (el.globalId === targetGlobalId) continue;
    const elPoints = [el.start, el.end];
    const touches = targetPoints.some((tp) => elPoints.some((ep) => distance(tp, ep) <= toleranceMm));
    if (touches) found.push(el.globalId);
  }
  return found;
}

/**
 * Browser convenience: open the IFC bytes, extract all endpoints, and find
 * members connected to `targetGlobalId`.
 */
export async function findConnectedMembersFromBytes(
  bytes: Uint8Array,
  targetGlobalId: string,
  toleranceMm: number = DEFAULT_JOINT_TOLERANCE_MM,
  options?: { allowBrepFallback?: boolean },
): Promise<string[]> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    const endpoints = extractAllMemberEndpoints(api, modelID, options);
    return findConnectedMembers(endpoints, targetGlobalId, toleranceMm);
  } finally {
    api.CloseModel(modelID);
  }
}
