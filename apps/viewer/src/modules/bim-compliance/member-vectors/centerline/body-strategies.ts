/**
 * Centerline strategies that read the member's **Body** representation, used
 * when there is no Axis curve (or as a cross-check):
 *   - IfcExtrudedAreaSolid → straight centerline from the extrusion ("body-extrusion")
 *   - triangulated IfcFacetedBrep → PCA fit + near-joint tangents ("mesh-pca")
 *
 * The raw Brep faces are gathered once by {@link collectBodyFaces} and reused by
 * both the PCA fit here and the cardinal-offset slicing in `cardinal-correction.ts`
 * (via {@link brepWorldVertices}) — so a member's mesh is never extracted twice.
 */

import {
  IFCBOOLEANCLIPPINGRESULT,
  IFCBOOLEANRESULT,
  IFCCLOSEDSHELL,
  IFCEXTRUDEDAREASOLID,
  IFCFACE,
  IFCFACETEDBREP,
  IFCMAPPEDITEM,
  IFCPOLYLOOP,
  IfcAPI,
} from "web-ifc";

import {
  axis2placementMatrix,
  cartesianTransformMatrix,
  identity,
  line,
  type Mat4,
  multiply,
  normalize,
  num,
  ratios,
  str,
  transformPoint,
} from "../ifc-core";
import type { CenterlineCandidate } from "./types";

type Vec3 = [number, number, number];

/** A Brep face = its polygon vertices, each with the extraMatrix (IfcMappedItem) in force where it was collected. */
export type BrepFace = { p: Vec3; m: Mat4 }[];

// ---------------------------------------------------------------------------
// Body extrusion (parametric — straight members)
// ---------------------------------------------------------------------------

/**
 * Recursively find the first IfcExtrudedAreaSolid under a Body representation
 * item, composing IfcMappedItem's MappingTarget along the way.
 */
function findExtrudedSolid(
  api: IfcAPI,
  modelID: number,
  itemRef: unknown,
  extraMatrix: Mat4,
): { solid: any; extraMatrix: Mat4 } | null {
  const item = line(api, modelID, itemRef);
  if (!item) return null;

  if (item.type === IFCEXTRUDEDAREASOLID) {
    return { solid: item, extraMatrix };
  }

  if (item.type === IFCMAPPEDITEM) {
    const mappingSource = line(api, modelID, item.MappingSource);
    if (!mappingSource) return null;
    const mappingTarget = cartesianTransformMatrix(api, modelID, item.MappingTarget);
    const mappedRep = line(api, modelID, mappingSource.MappedRepresentation);
    if (!mappedRep || !Array.isArray(mappedRep.Items)) return null;
    const composed = multiply(extraMatrix, mappingTarget);
    for (const innerRef of mappedRep.Items) {
      const found = findExtrudedSolid(api, modelID, innerRef, composed);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Fallback centerline when no Axis/FootPrint representation exists (seen on
 * some Tekla/Revit exports that only emit a Body SweptSolid): derive it from
 * the Body's IfcExtrudedAreaSolid — Position places the swept profile's local
 * origin/Z in the object's own frame, and the centerline runs from that origin
 * along ExtrudedDirection for Depth.
 */
export function tryBodyExtrusion(api: IfcAPI, modelID: number, element: any): CenterlineCandidate | null {
  const prodShape = line(api, modelID, element.Representation);
  if (!prodShape || !Array.isArray(prodShape.Representations)) return null;

  for (const repRef of prodShape.Representations) {
    const rep = line(api, modelID, repRef);
    if (!rep || !Array.isArray(rep.Items)) continue;
    const ident = str(rep.RepresentationIdentifier);
    if (ident && ident !== "Body") continue;

    for (const itemRef of rep.Items) {
      const found = findExtrudedSolid(api, modelID, itemRef, identity());
      if (!found) continue;
      const { solid, extraMatrix } = found;

      const depth = num(solid.Depth);
      if (!(depth > 0)) continue;
      const dirLine = line(api, modelID, solid.ExtrudedDirection);
      let dir = dirLine ? ratios(dirLine.DirectionRatios) : [0, 0, 1];
      if (dir.length < 3) dir = [dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 1];
      dir = normalize(dir);

      const positionMatrix = axis2placementMatrix(api, modelID, line(api, modelID, solid.Position));
      const localStart: Vec3 = [0, 0, 0];
      const localEnd: Vec3 = [dir[0] * depth, dir[1] * depth, dir[2] * depth];

      return {
        source: "body-extrusion",
        usesMesh: false,
        localStart,
        localEnd,
        extraMatrix: multiply(extraMatrix, positionMatrix),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body mesh (triangulated Brep — PCA + near-joint tangents)
// ---------------------------------------------------------------------------

/**
 * Recursively collect every face of an IfcFacetedBrep, each as its own group of
 * IfcCartesianPoints (in the Brep's own local coordinates) — the PCA fit needs
 * the face grouping to find mesh vertices topologically adjacent to a cap face,
 * not just a flat point cloud. Unwraps IfcMappedItem (composing MappingTarget)
 * and IfcBooleanClippingResult / IfcBooleanResult (Tekla/Revit bolt-cut &
 * end-clip members wrap the base solid in one of these — only FirstOperand is
 * the solid being clipped; SecondOperand is the clipping tool, ignored).
 */
function collectBrepFaces(api: IfcAPI, modelID: number, itemRef: unknown, extraMatrix: Mat4, out: BrepFace[]): void {
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
  const outer = line(api, modelID, item.Outer);
  if (!outer || outer.type !== IFCCLOSEDSHELL || !Array.isArray(outer.CfsFaces)) return;

  for (const faceRef of outer.CfsFaces) {
    const face = line(api, modelID, faceRef);
    if (!face || face.type !== IFCFACE || !Array.isArray(face.Bounds)) continue;
    const facePts: BrepFace = [];
    for (const boundRef of face.Bounds) {
      const bound = line(api, modelID, boundRef);
      const loop = bound ? line(api, modelID, bound.Bound) : null;
      if (!loop || loop.type !== IFCPOLYLOOP || !Array.isArray(loop.Polygon)) continue;
      for (const ptRef of loop.Polygon) {
        const pt = line(api, modelID, ptRef);
        if (!pt) continue;
        const c = ratios(pt.Coordinates);
        facePts.push({ p: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0], m: extraMatrix });
      }
    }
    if (facePts.length > 0) out.push(facePts);
  }
}

/**
 * Gather all Body-representation Brep faces of a member ONCE (in local
 * coordinates, each vertex carrying its own extraMatrix). Empty when the Body
 * is parametric (no triangulated Brep). Shared by {@link tryMeshPca} and
 * {@link brepWorldVertices} so the mesh is read only once per member.
 */
export function collectBodyFaces(api: IfcAPI, modelID: number, element: any): BrepFace[] {
  const prodShape = line(api, modelID, element.Representation);
  if (!prodShape || !Array.isArray(prodShape.Representations)) return [];
  const faceGroups: BrepFace[] = [];
  for (const repRef of prodShape.Representations) {
    const rep = line(api, modelID, repRef);
    if (!rep || !Array.isArray(rep.Items)) continue;
    const ident = str(rep.RepresentationIdentifier);
    if (ident && ident !== "Body") continue;
    for (const itemRef of rep.Items) collectBrepFaces(api, modelID, itemRef, identity(), faceGroups);
  }
  return faceGroups;
}

/** All body-mesh vertices in WORLD space (placement × per-vertex extraMatrix × localPoint). */
export function brepWorldVertices(faces: BrepFace[], placementMatrix: Mat4): Vec3[] {
  const out: Vec3[] = [];
  for (const face of faces) for (const { p, m } of face) out.push(transformPoint(placementMatrix, transformPoint(m, p)));
  return out;
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
 * Principal axis (dominant eigenvector of the point cloud's covariance, via
 * power iteration) — the length direction of a prismatic member's mesh.
 */
function pcaPrincipalAxis(pts: Vec3[]): Vec3 | null {
  const n = pts.length;
  if (n < 3) return null;

  const centroid: Vec3 = [0, 0, 0];
  for (const p of pts) { centroid[0] += p[0]; centroid[1] += p[1]; centroid[2] += p[2]; }
  centroid[0] /= n; centroid[1] /= n; centroid[2] /= n;

  // 3x3 covariance matrix of the centered points.
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const dx = p[0] - centroid[0], dy = p[1] - centroid[1], dz = p[2] - centroid[2];
    cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
    cov[4] += dy * dy; cov[5] += dy * dz;
    cov[8] += dz * dz;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];

  // Power iteration for the dominant eigenvector (principal/length axis).
  let axis = [1, 1, 1];
  for (let iter = 0; iter < 50; iter++) {
    const next = [
      cov[0] * axis[0] + cov[1] * axis[1] + cov[2] * axis[2],
      cov[3] * axis[0] + cov[4] * axis[1] + cov[5] * axis[2],
      cov[6] * axis[0] + cov[7] * axis[1] + cov[8] * axis[2],
    ];
    const mag = Math.hypot(next[0], next[1], next[2]);
    if (mag === 0) return null;
    axis = [next[0] / mag, next[1] / mag, next[2] / mag];
  }

  return axis as Vec3;
}

/** Local-tangent deviation from the whole-length chord beyond which a member is treated as curved. */
const CURVE_THRESHOLD_DEG = 1.5;
/**
 * Minimum length-to-cross-section aspect ratio to even ATTEMPT a near-joint
 * tangent. Below this the mesh isn't a slender prismatic member and the
 * whole-mesh PCA "length axis" / end-cap identification is unreliable (flat
 * plates → PCA picks a face diagonal; short stubs → no meaningful axis). Both
 * would otherwise emit a spurious ~40-45° tangent. Genuine curved tubes sit
 * well above this (B20 ≈ 5.6, arched "OLUK" ≈ 16).
 */
const MIN_TANGENT_ASPECT = 3;

/**
 * Fallback centerline for members whose Body is a raw triangulated
 * IfcFacetedBrep (no parametric solid — seen on Tekla braces end-clipped at
 * their joints). PCA gives the length axis; the two end-cap centroids give
 * start/end. For a BENT member the whole-mesh axis is only the average slope,
 * so a *local* tangent at each end is also derived from the mesh topology: the
 * end-cap face (its Newell normal ~parallel to the axis) averaged with the
 * vertices of every adjacent face sharing a vertex with it. When either end's
 * tangent deviates from the whole-length chord by more than `CURVE_THRESHOLD_DEG`,
 * the near-joint tangent is emitted for the caller to prefer over the chord.
 *
 * Takes pre-collected `faces` (see {@link collectBodyFaces}) so the mesh is
 * read once. Works in the object-local frame (each vertex's own extraMatrix
 * applied); the caller composes placement afterwards.
 */
export function tryMeshPca(faces: BrepFace[]): CenterlineCandidate | null {
  const raw = faces.flat();
  if (raw.length < 3) return null;

  // Apply each vertex's own extraMatrix so everything lands in one common
  // (the object's own placement) frame before PCA.
  const pts = raw.map(({ p, m }) => transformPoint(m, p));
  const facePts = faces.map((f) => f.map(({ p, m }) => transformPoint(m, p)));

  const axis = pcaPrincipalAxis(pts);
  if (!axis) return null;
  const centroid: Vec3 = [0, 0, 0];
  for (const p of pts) { centroid[0] += p[0]; centroid[1] += p[1]; centroid[2] += p[2]; }
  centroid[0] /= pts.length; centroid[1] /= pts.length; centroid[2] /= pts.length;
  const projOf = (p: Vec3): number =>
    (p[0] - centroid[0]) * axis[0] + (p[1] - centroid[1]) * axis[1] + (p[2] - centroid[2]) * axis[2];

  let tMin = Infinity;
  let tMax = -Infinity;
  const projections = pts.map((p) => {
    const t = projOf(p);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    return t;
  });
  if (!(tMax > tMin)) return null;

  // Average the vertices within 2% of each extreme (the end-cap ring) instead
  // of taking a single point, to cancel out cap-ring noise.
  const span = tMax - tMin;
  const tol = Math.max(span * 0.02, 1e-6);
  const capAvg = (predicate: (t: number) => boolean): Vec3 => {
    const acc: Vec3 = [0, 0, 0];
    let count = 0;
    pts.forEach((p, i) => {
      if (!predicate(projections[i])) return;
      acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2];
      count++;
    });
    return count > 0 ? [acc[0] / count, acc[1] / count, acc[2] / count] : centroid;
  };

  const localStart = capAvg((t) => t <= tMin + tol);
  const localEnd = capAvg((t) => t >= tMax - tol);

  const straight: CenterlineCandidate = { source: "mesh-pca", usesMesh: true, localStart, localEnd, extraMatrix: identity() };

  // Aspect-ratio gate: only slender prismatic members get a near-joint tangent.
  let crossSectionRadius = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const t = projections[i];
    const perp = Math.hypot(
      p[0] - centroid[0] - t * axis[0],
      p[1] - centroid[1] - t * axis[1],
      p[2] - centroid[2] - t * axis[2],
    );
    if (perp > crossSectionRadius) crossSectionRadius = perp;
  }
  if (crossSectionRadius < 1e-6 || span / crossSectionRadius < MIN_TANGENT_ASPECT) return straight;

  // Identify the two end-cap faces: the ones whose own (Newell) normal is most
  // closely aligned (|dot|, sign-agnostic) with the whole-mesh axis.
  const facesWithNormals = facePts
    .filter((f) => f.length >= 3)
    .map((f) => ({ pts: f, normal: faceNormalAndArea(f).normal }));
  if (facesWithNormals.length < 2) return straight;
  const byAlignmentDesc = [...facesWithNormals].sort(
    (a, b) =>
      Math.abs(b.normal[0] * axis[0] + b.normal[1] * axis[1] + b.normal[2] * axis[2]) -
      Math.abs(a.normal[0] * axis[0] + a.normal[1] * axis[1] + a.normal[2] * axis[2]),
  );
  const faceCentroid = (f: Vec3[]): Vec3 => {
    const acc: Vec3 = [0, 0, 0];
    for (const p of f) { acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; }
    return [acc[0] / f.length, acc[1] / f.length, acc[2] / f.length];
  };
  const [capA, capB] =
    projOf(faceCentroid(byAlignmentDesc[0].pts)) <= projOf(faceCentroid(byAlignmentDesc[1].pts))
      ? [byAlignmentDesc[0], byAlignmentDesc[1]]
      : [byAlignmentDesc[1], byAlignmentDesc[0]];

  const eps = Math.max(span * 1e-6, 1e-6);
  const samePoint = (a: Vec3, b: Vec3): boolean =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;

  const nextRingIn = (cap: { pts: Vec3[] }): Vec3 | null => {
    const acc: Vec3 = [0, 0, 0];
    let count = 0;
    for (const other of facesWithNormals) {
      if (other.pts === cap.pts) continue;
      const sharesVertex = other.pts.some((p) => cap.pts.some((cp) => samePoint(p, cp)));
      if (!sharesVertex) continue;
      for (const p of other.pts) {
        if (cap.pts.some((cp) => samePoint(p, cp))) continue;
        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2];
        count++;
      }
    }
    return count > 0 ? [acc[0] / count, acc[1] / count, acc[2] / count] : null;
  };
  const dirBetween = (a: Vec3, b: Vec3): Vec3 | null => {
    const v: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const m = Math.hypot(v[0], v[1], v[2]);
    return m === 0 ? null : [v[0] / m, v[1] / m, v[2] / m];
  };

  const nextInStart = nextRingIn(capA);
  const nextInEnd = nextRingIn(capB);
  const tangentStart = nextInStart ? dirBetween(faceCentroid(capA.pts), nextInStart) : null;
  const tangentEnd = nextInEnd ? dirBetween(nextInEnd, faceCentroid(capB.pts)) : null;

  // Deviation is measured against the END-TO-END CHORD (what the caller falls
  // back to when no tangent is emitted), NOT the PCA axis.
  const chordDir = dirBetween(localStart, localEnd) ?? axis;
  const angleFromChordDeg = (v: Vec3 | null): number => {
    if (!v) return 0;
    const d = Math.min(1, Math.abs(v[0] * chordDir[0] + v[1] * chordDir[1] + v[2] * chordDir[2]));
    return (Math.acos(d) * 180) / Math.PI;
  };
  const curved = angleFromChordDeg(tangentStart) > CURVE_THRESHOLD_DEG || angleFromChordDeg(tangentEnd) > CURVE_THRESHOLD_DEG;

  return {
    ...straight,
    ...(curved && tangentStart ? { localTangentStart: tangentStart } : {}),
    ...(curved && tangentEnd ? { localTangentEnd: tangentEnd } : {}),
  };
}
