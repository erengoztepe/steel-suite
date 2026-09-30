/**
 * Low-level web-ifc value/matrix primitives shared across the member-vectors
 * module (centerline strategies, the joint solver's callers, plate-dxf) and
 * the browser-native port of Eren's `vektorcek.txt` IfcOpenShell script.
 *
 * Nothing here knows about beams/columns/joints — it's pure IFC-line-graph and
 * 4x4-matrix plumbing (get_local_placement equivalents, EXPRESS attribute
 * unwrapping). See `centerline/` for the strategies that use these to resolve
 * a member's centerline, and `extract-member-vectors.ts` for orchestration.
 */

import { IfcAPI } from "web-ifc";

/** web-ifc WASM, copied to /public/wasm/web-ifc/ at build time (same as GeometryEngine). */
export const WASM_PATH = "/wasm/web-ifc/";

/** Shared with plate-dxf's outline extraction — same web-ifc traversal/matrix primitives. */
export type Mat4 = number[]; // length 16, row-major

// ---------------------------------------------------------------------------
// Low-level web-ifc value helpers
// ---------------------------------------------------------------------------

/** Express id from a handle/number, or null. */
export function handleId(h: unknown): number | null {
  if (typeof h === "number") return h;
  if (h && typeof h === "object" && "value" in h) {
    const v = (h as { value: unknown }).value;
    if (typeof v === "number") return v;
  }
  return null;
}

/** GetLine for a handle/number reference. */
export function line(api: IfcAPI, modelID: number, ref: unknown): any | null {
  const id = handleId(ref);
  if (id == null) return null;
  try {
    return api.GetLine(modelID, id);
  } catch {
    return null;
  }
}

/** Unwrap a scalar IFC attribute ({ value } wrapper or raw). */
export function num(x: unknown): number {
  if (typeof x === "number") return x;
  if (x && typeof x === "object" && "value" in x) {
    const v = (x as { value: unknown }).value;
    if (typeof v === "number") return v;
  }
  return 0;
}

export function str(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object" && "value" in x) {
    const v = (x as { value: unknown }).value;
    return v == null ? "" : String(v);
  }
  return String(x);
}

/** DirectionRatios / Coordinates → number[]. */
export function ratios(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.map((v) => num(v));
}

// ---------------------------------------------------------------------------
// 4x4 matrix math (row-major), mirroring get_local_placement
// ---------------------------------------------------------------------------

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

/** M @ [x,y,z,1] → [x',y',z']. */
export function transformPoint(m: Mat4, p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/** M's linear part (no translation) applied to a direction, renormalized. */
export function transformDirection(m: Mat4, v: [number, number, number]): [number, number, number] {
  const [x, y, z] = v;
  const out = [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
  const n = Math.hypot(out[0], out[1], out[2]);
  return n === 0 ? [0, 0, 0] : [out[0] / n, out[1] / n, out[2] / n];
}

export function normalize(v: number[]): number[] {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}

export function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Reference "up" for building an in-plane frame ⊥ a member's local tangent — shared by cardinal-correction. */
export const GLOBAL_UP = [0, 0, 1];

/** Build the 4x4 for an IfcAxis2Placement2D/3D (basis vectors as columns). */
export function axis2placementMatrix(api: IfcAPI, modelID: number, placement: any): Mat4 {
  if (!placement) return identity();

  const loc = line(api, modelID, placement.Location);
  const location = loc ? ratios(loc.Coordinates) : [0, 0, 0];
  const px = location[0] ?? 0;
  const py = location[1] ?? 0;
  const pz = location[2] ?? 0;

  // Z axis (Axis) and X axis (RefDirection). Defaults per IFC spec.
  const axisDir = line(api, modelID, placement.Axis);
  const refDir = line(api, modelID, placement.RefDirection);
  let z = axisDir ? ratios(axisDir.DirectionRatios) : [0, 0, 1];
  let xRef = refDir ? ratios(refDir.DirectionRatios) : [1, 0, 0];
  if (z.length < 3) z = [z[0] ?? 0, z[1] ?? 0, z[2] ?? 1];
  if (xRef.length < 3) xRef = [xRef[0] ?? 1, xRef[1] ?? 0, xRef[2] ?? 0];

  z = normalize(z);
  // Gram-Schmidt: make X orthogonal to Z.
  const dot = xRef[0] * z[0] + xRef[1] * z[1] + xRef[2] * z[2];
  let x = normalize([xRef[0] - dot * z[0], xRef[1] - dot * z[1], xRef[2] - dot * z[2]]);
  if (Math.hypot(x[0], x[1], x[2]) === 0) x = [1, 0, 0];
  const y = cross(z, x);

  // Columns = [x, y, z, location].
  return [
    x[0], y[0], z[0], px,
    x[1], y[1], z[1], py,
    x[2], y[2], z[2], pz,
    0, 0, 0, 1,
  ];
}

/** Recursively compose an IfcLocalPlacement chain → global 4x4. */
export function getLocalPlacement(api: IfcAPI, modelID: number, placementRef: unknown): Mat4 {
  const placement = line(api, modelID, placementRef);
  if (!placement) return identity();

  // IfcLocalPlacement: PlacementRelTo (parent) + RelativePlacement (axis2placement)
  const relative = axis2placementMatrix(api, modelID, line(api, modelID, placement.RelativePlacement));
  if (placement.PlacementRelTo) {
    const parent = getLocalPlacement(api, modelID, placement.PlacementRelTo);
    return multiply(parent, relative);
  }
  return relative;
}

/**
 * Build the 4x4 for an IfcCartesianTransformationOperator3D (used by
 * IfcMappedItem.MappingTarget). Unlike Axis2Placement3D, Axis1/Axis2/Axis3 can
 * all be given explicitly; each defaults per the IFC spec when omitted.
 * Non-uniform scale is ignored — irrelevant for line/direction extraction.
 */
export function cartesianTransformMatrix(api: IfcAPI, modelID: number, ref: unknown): Mat4 {
  const op = line(api, modelID, ref);
  if (!op) return identity();

  const originPt = line(api, modelID, op.LocalOrigin);
  const origin = originPt ? ratios(originPt.Coordinates) : [0, 0, 0];

  const ax1 = line(api, modelID, op.Axis1);
  const ax3 = line(api, modelID, op.Axis3);
  let x = ax1 ? ratios(ax1.DirectionRatios) : [1, 0, 0];
  let z = ax3 ? ratios(ax3.DirectionRatios) : [0, 0, 1];
  if (x.length < 3) x = [x[0] ?? 1, x[1] ?? 0, x[2] ?? 0];
  if (z.length < 3) z = [z[0] ?? 0, z[1] ?? 0, z[2] ?? 1];

  z = normalize(z);
  const dot = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = normalize([x[0] - dot * z[0], x[1] - dot * z[1], x[2] - dot * z[2]]);
  if (Math.hypot(x[0], x[1], x[2]) === 0) x = [1, 0, 0];

  const ax2 = line(api, modelID, op.Axis2);
  const y = ax2 ? normalize(ratios(ax2.DirectionRatios)) : cross(z, x);

  return [
    x[0], y[0], z[0], origin[0] ?? 0,
    x[1], y[1], z[1], origin[1] ?? 0,
    x[2], y[2], z[2], origin[2] ?? 0,
    0, 0, 0, 1,
  ];
}
