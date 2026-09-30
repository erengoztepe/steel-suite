/**
 * Extracts a flat plate's exact 2D cross-section (outer contour + any holes)
 * from its raw IfcPlate Brep geometry, for DXF export.
 *
 * Tekla's IFC export (verified against a real Staff_Entrance export: 1598
 * IfcPlate elements, 0 IfcExtrudedAreaSolid among them) represents plates as
 * plain IfcFacetedBrep — straight-edge polygon faces, no boolean
 * clipping/booleans, holes (when present) as a face's inner IfcFaceBound
 * loops. A flat plate's two largest faces are its top/bottom skin; picking
 * whichever is largest (by Newell-method planar area) gives the plate's exact
 * outline — no reconstruction or approximation beyond what Tekla itself
 * already baked into the polygon geometry (its bolt-hole circles are already
 * polygon-approximated by Tekla, not true arcs).
 *
 * Reuses the low-level web-ifc traversal/matrix primitives from
 * `extract-member-vectors.ts` (same IfcMappedItem / IfcBooleanClippingResult
 * unwrapping conventions) rather than re-deriving them.
 */

import { IFCBOOLEANCLIPPINGRESULT, IFCBOOLEANRESULT, IFCCLOSEDSHELL, IFCFACE, IFCFACEOUTERBOUND, IFCFACETEDBREP, IFCMAPPEDITEM, IFCPLATE, IFCPOLYLOOP, IfcAPI } from "web-ifc";

import {
  cartesianTransformMatrix,
  cross,
  identity,
  line,
  multiply,
  normalize,
  ratios,
  str,
  transformPoint,
  WASM_PATH,
  type Mat4,
} from "../member-vectors/extract-member-vectors";

export interface PlateOutline {
  globalId: string;
  name: string;
  /** Distance (mm) to the parallel opposite face, when found. */
  thicknessMm: number;
  /** Outer contour in the flattened plane, mm; DXF +Y = global up (+Z). */
  outerMm: [number, number][];
  /** Hole contours (e.g. bolt holes actually cut into the plate), wound opposite to the outer. */
  holesMm: [number, number][][];
  /** Set when the geometry doesn't look like a simple flat plate — result may be unreliable. */
  warning?: string;
}

type Vec3 = [number, number, number];
interface RawPoint {
  p: Vec3;
  m: Mat4;
}
interface RawFace {
  outer: RawPoint[];
  holes: RawPoint[][];
}
interface AnalyzedFace {
  outerPts: Vec3[];
  holes: Vec3[][];
  normal: Vec3;
  area: number;
}

/** Newell's method: robust to slight non-planarity; also gives the polygon's area. */
function faceNormalAndArea(pts: Vec3[]): { normal: Vec3; area: number } {
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1, z1] = pts[i];
    const [x2, y2, z2] = pts[(i + 1) % n];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  const mag = Math.hypot(nx, ny, nz);
  return { normal: mag > 0 ? [nx / mag, ny / mag, nz / mag] : [0, 0, 1], area: mag / 2 };
}

/**
 * Recursively collect every face of an IfcFacetedBrep, each as an outer loop
 * + any inner (hole) loops, in the Brep's own local coordinates. Mirrors
 * `collectBrepVertices`'s IfcMappedItem / IfcBooleanClippingResult /
 * IfcBooleanResult unwrapping, but keeps face/loop structure instead of
 * flattening to a bare point cloud.
 */
function collectBrepFaces(api: IfcAPI, modelID: number, itemRef: unknown, extraMatrix: Mat4, out: RawFace[]): void {
  const item = line(api, modelID, itemRef);
  if (!item) return;

  if (item.type === IFCBOOLEANCLIPPINGRESULT || item.type === IFCBOOLEANRESULT) {
    collectBrepFaces(api, modelID, item.FirstOperand, extraMatrix, out);
    return;
  }

  if (item.type === IFCMAPPEDITEM) {
    const mappingSource = line(api, modelID, item.MappingSource);
    if (!mappingSource) return;
    const mappingTarget = cartesianTransformMatrix(api, modelID, item.MappingTarget);
    const mappedRep = line(api, modelID, mappingSource.MappedRepresentation);
    if (!mappedRep || !Array.isArray(mappedRep.Items)) return;
    const composed = multiply(extraMatrix, mappingTarget);
    for (const innerRef of mappedRep.Items) collectBrepFaces(api, modelID, innerRef, composed, out);
    return;
  }

  if (item.type !== IFCFACETEDBREP) return;
  const outerShell = line(api, modelID, item.Outer);
  if (!outerShell || outerShell.type !== IFCCLOSEDSHELL || !Array.isArray(outerShell.CfsFaces)) return;

  for (const faceRef of outerShell.CfsFaces) {
    const face = line(api, modelID, faceRef);
    if (!face || face.type !== IFCFACE || !Array.isArray(face.Bounds)) continue;

    const bounds: { pts: RawPoint[]; isOuter: boolean }[] = [];
    for (const boundRef of face.Bounds) {
      const bound = line(api, modelID, boundRef);
      const loop = bound ? line(api, modelID, bound.Bound) : null;
      if (!loop || loop.type !== IFCPOLYLOOP || !Array.isArray(loop.Polygon)) continue;
      const pts: RawPoint[] = loop.Polygon.map((ptRef: unknown) => {
        const pt = line(api, modelID, ptRef);
        const c = pt ? ratios(pt.Coordinates) : [0, 0, 0];
        return { p: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0] as Vec3, m: extraMatrix };
      });
      if (pts.length >= 3) bounds.push({ pts, isOuter: bound?.type === IFCFACEOUTERBOUND });
    }
    if (bounds.length === 0) continue;

    // The IfcFaceOuterBound-typed loop is the outer contour by definition. If
    // none is tagged that way (single-bound face, or malformed data), fall
    // back to the largest-area loop.
    let outerIdx = bounds.findIndex((b) => b.isOuter);
    if (outerIdx === -1) {
      outerIdx = 0;
      let bestArea = -1;
      bounds.forEach((b, i) => {
        const pts3 = b.pts.map((x) => transformPoint(x.m, x.p));
        const { area } = faceNormalAndArea(pts3);
        if (area > bestArea) { bestArea = area; outerIdx = i; }
      });
    }
    out.push({ outer: bounds[outerIdx].pts, holes: bounds.filter((_, i) => i !== outerIdx).map((b) => b.pts) });
  }
}

/**
 * Extract the given plate's outline. Requires an already-open web-ifc model
 * (mirrors `extractMemberVectors`'s api/modelID convention).
 */
export function extractPlateOutline(api: IfcAPI, modelID: number, globalId: string): PlateOutline | null {
  const idsHandle = api.GetLineIDsWithType(modelID, IFCPLATE) as any;
  const count = Array.isArray(idsHandle) ? idsHandle.length : idsHandle.size();
  let element: any = null;
  for (let i = 0; i < count; i++) {
    const id = Array.isArray(idsHandle) ? idsHandle[i] : idsHandle.get(i);
    const el = line(api, modelID, id);
    if (el && str(el.GlobalId) === globalId) { element = el; break; }
  }
  if (!element) return null;

  const prodShape = line(api, modelID, element.Representation);
  if (!prodShape || !Array.isArray(prodShape.Representations)) return null;

  const faces: RawFace[] = [];
  for (const repRef of prodShape.Representations) {
    const rep = line(api, modelID, repRef);
    if (!rep || !Array.isArray(rep.Items)) continue;
    const ident = str(rep.RepresentationIdentifier);
    if (ident && ident !== "Body") continue;
    for (const itemRef of rep.Items) collectBrepFaces(api, modelID, itemRef, identity(), faces);
  }
  if (faces.length === 0) return null;

  const analyzed: AnalyzedFace[] = faces
    .map((f) => {
      const outerPts = f.outer.map(({ p, m }) => transformPoint(m, p));
      const { normal, area } = faceNormalAndArea(outerPts);
      return { outerPts, holes: f.holes.map((h) => h.map(({ p, m }) => transformPoint(m, p))), normal, area };
    })
    .filter((f) => f.area > 1e-6);
  if (analyzed.length === 0) return null;

  analyzed.sort((a, b) => b.area - a.area);
  const best = analyzed[0];

  // The face parallel-opposite to `best` (its expected top/bottom pair) is
  // normal, not a sign of trouble — a flat plate's two big faces are
  // (near-)identical in area by construction. A THIRD face comparably large
  // but not that pair (e.g. a folded/L-shaped part) is what's actually ambiguous.
  let pairIdx = -1;
  for (let i = 1; i < analyzed.length; i++) {
    const dot =
      analyzed[i].normal[0] * best.normal[0] + analyzed[i].normal[1] * best.normal[1] + analyzed[i].normal[2] * best.normal[2];
    if (dot < -0.9) { pairIdx = i; break; }
  }
  const pair = pairIdx >= 0 ? analyzed[pairIdx] : null;
  const otherCandidate = analyzed.find((f, i) => i !== 0 && i !== pairIdx && f.area > best.area * 0.5);

  let thicknessMm = 0;
  if (pair) {
    const dx = pair.outerPts[0][0] - best.outerPts[0][0];
    const dy = pair.outerPts[0][1] - best.outerPts[0][1];
    const dz = pair.outerPts[0][2] - best.outerPts[0][2];
    thicknessMm = Math.abs(dx * best.normal[0] + dy * best.normal[1] + dz * best.normal[2]);
  }

  // --- 2D projection basis, oriented to preserve the plate's global "up" ----
  // The plate is flattened onto AutoCAD's XY plane; DXF +Y must point the same
  // way "up" does in the viewer (global +Z) so the plate's bottom edge in the
  // model stays its bottom edge in the DXF. Two independent choices drive that:
  //
  //  1. Which face we view through (the out-of-plane axis). The larger-face
  //     sort above is a near-tie between the two skins, so its winner — and
  //     thus `best.normal`'s SIGN — is essentially arbitrary and would mirror
  //     the part run-to-run. Instead pick the sign from a deterministic global
  //     reference: view from the +Z side, falling back to +Y then +X for a
  //     plate whose face is perpendicular to Z (and then Z-Y).
  //  2. In-plane "up" (DXF +Y) = global +Z projected into the plate plane.
  //     For a (near-)horizontal plate up is ∥ the normal so that projection
  //     vanishes; fall back to global +Y then +X as the drawing's up.
  //
  // (`best.normal` is still used as-is for the thickness pairing above; only
  // the projection uses this re-oriented `viewN`.)
  const GLOBAL_REFS: Vec3[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
  let viewN: Vec3 = [best.normal[0], best.normal[1], best.normal[2]];
  for (const r of GLOBAL_REFS) {
    const d = viewN[0] * r[0] + viewN[1] * r[1] + viewN[2] * r[2];
    if (Math.abs(d) > 1e-6) {
      if (d < 0) viewN = [-viewN[0], -viewN[1], -viewN[2]];
      break;
    }
  }
  const upInPlane = (up: Vec3): Vec3 => {
    const d = up[0] * viewN[0] + up[1] * viewN[1] + up[2] * viewN[2];
    return normalize([up[0] - d * viewN[0], up[1] - d * viewN[1], up[2] - d * viewN[2]]) as Vec3;
  };
  let v = upInPlane([0, 0, 1]);
  if (Math.hypot(v[0], v[1], v[2]) < 1e-6) v = upInPlane([0, 1, 0]);
  if (Math.hypot(v[0], v[1], v[2]) < 1e-6) v = upInPlane([1, 0, 0]);
  // Right-handed screen basis with viewN toward the viewer: cross(u, v) = viewN.
  const u = cross(v, viewN) as Vec3;

  const origin = best.outerPts[0];
  const project = (p: Vec3): [number, number] => {
    const dx = p[0] - origin[0], dy = p[1] - origin[1], dz = p[2] - origin[2];
    return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
  };
  const outerMm = best.outerPts.map(project);
  const holesMm = best.holes.map((loop) => loop.map(project));

  // Anchor to the min corner so the part sits in AutoCAD's positive quadrant
  // with its bottom edge at Y=0. Pure translation — orientation is untouched —
  // and it also makes the output stable regardless of which of the two
  // near-equal skins the area sort picked as `best` (that choice only shifts
  // the origin, since the projection basis is derived from the global-up
  // reference, not from `best`).
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of outerMm) { if (x < minX) minX = x; if (y < minY) minY = y; }
  const shift = (pts: [number, number][]): [number, number][] => pts.map(([x, y]) => [x - minX, y - minY]);

  return {
    globalId,
    name: str(element.Name),
    thicknessMm,
    outerMm: shift(outerMm),
    holesMm: holesMm.map(shift),
    warning: !pair || otherCandidate
      ? "Bu elemanın geometrisi basit bir düz plaka gibi görünmüyor; çıkarılan kesit tam doğru olmayabilir."
      : undefined,
  };
}

/** Browser convenience: open the IFC bytes with a fresh web-ifc model, extract, close. */
export async function extractPlateOutlineFromBytes(bytes: Uint8Array, globalId: string): Promise<PlateOutline | null> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    return extractPlateOutline(api, modelID, globalId);
  } finally {
    api.CloseModel(modelID);
  }
}
