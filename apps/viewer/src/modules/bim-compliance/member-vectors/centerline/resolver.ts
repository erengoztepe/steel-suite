/**
 * The centerline PLANNER. Given one IFC member it:
 *   1. runs the cheap strategies (Axis curve, Body extrusion) — no geometry cost;
 *   2. reads the Body mesh AT MOST ONCE, and only when needed (a curved axis to
 *      centroid-correct, or no cheap method available and mesh fallback is on);
 *   3. picks the highest-confidence candidate as PRIMARY;
 *   4. centroid-corrects a curved primary (cardinal-offset) using that one mesh;
 *   5. CROSS-CHECKS the primary against the best comparable alternative and
 *      reports the endpoint disagreement (mm) — the basis for future automatic
 *      method selection without the Tekla/Autodesk toggle.
 *
 * This replaces the old fixed `axisEndpoints()` short-circuit ("first method
 * that works wins, others never run"): methods no longer mutually exclude — when
 * more than one applies they are compared, without turning cheap members into
 * expensive ones.
 */

import { IfcAPI } from "web-ifc";

import {
  getLocalPlacement,
  type Mat4,
  multiply,
  transformDirection,
  transformPoint,
} from "../ifc-core";
import { tryAxisStrategies } from "./axis-strategies";
import { brepWorldVertices, type BrepFace, collectBodyFaces, tryBodyExtrusion, tryMeshPca } from "./body-strategies";
import { curvedCentroidOffset } from "./cardinal-correction";
import type { CenterlineCandidate, CenterlineSource, CircleAxisCurve, ResolvedCenterline } from "./types";

type Vec3 = [number, number, number];

/** Lower = higher confidence / preferred as primary. */
const PRIORITY: Record<CenterlineSource, number> = {
  "axis-circle": 0,
  "axis-polyline": 1,
  "axis-line": 1,
  "body-extrusion": 2,
  "mesh-pca": 3,
};

function pickPrimary(candidates: CenterlineCandidate[]): CenterlineCandidate | null {
  let best: CenterlineCandidate | null = null;
  for (const c of candidates) if (!best || PRIORITY[c.source] < PRIORITY[best.source]) best = c;
  return best;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Transform a LOCAL circle by `matrix` → WORLD circle. */
function worldCurve(matrix: Mat4, c: CircleAxisCurve): CircleAxisCurve {
  return {
    center: transformPoint(matrix, c.center),
    xAxis: transformDirection(matrix, c.xAxis),
    yAxis: transformDirection(matrix, c.yAxis),
    radius: c.radius,
    theta1: c.theta1,
    theta2: c.theta2,
  };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Perpendicular distance from `p` to the INFINITE line through (a, b). */
function pointToLineDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abLen2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (abLen2 < 1e-12) return dist(p, a);
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLen2;
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

/**
 * Centerline disagreement (mm) between the PRIMARY (line through s1→e1) and an
 * alternative (s2, e2): the max perpendicular distance of the alternative's two
 * endpoints to the primary's infinite line. Deliberately extent-AGNOSTIC — a
 * member's parametric body is often trimmed shorter than its grid axis at a
 * joint, so their endpoints differ ALONG the axis while describing the same
 * line; that must NOT read as disagreement. What matters is whether the methods
 * put the centerline in the same PLACE (perpendicular offset — e.g. a cardinal
 * error), which this captures.
 */
function centerlineDisagreement(s1: Vec3, e1: Vec3, s2: Vec3, e2: Vec3): number {
  return Math.max(pointToLineDist(s2, s1, e1), pointToLineDist(e2, s1, e1));
}

export interface ResolveCenterlineOptions {
  /** Enable the triangulated-Brep mesh fallback (Tekla toggle). */
  allowMesh: boolean;
  /**
   * Force reading the mesh to cross-check even when a cheap axis method already
   * won (default false — keeps clean-axis members cheap). Off by default; here
   * so the toggle-free auto-selection experiment can turn it on later.
   */
  forceMeshCrossCheck?: boolean;
}

/**
 * Resolve one member's centerline to WORLD space with method + cross-check
 * metadata. null when no method produced a centerline.
 */
export function resolveCenterline(
  api: IfcAPI,
  modelID: number,
  element: any,
  opts: ResolveCenterlineOptions,
): ResolvedCenterline | null {
  const placementMatrix = getLocalPlacement(api, modelID, element.ObjectPlacement);

  // 1. Cheap candidates (no geometry cost).
  const candidates: CenterlineCandidate[] = [];
  const axis = tryAxisStrategies(api, modelID, element);
  if (axis) candidates.push(axis);
  const extrusion = tryBodyExtrusion(api, modelID, element);
  if (extrusion) candidates.push(extrusion);

  // 2. Mesh only when needed: a curved axis to centroid-correct, no cheap method
  //    (mesh fallback), or an explicit cross-check request.
  const cheapPrimary = pickPrimary(candidates);
  // The Body mesh is read AT MOST ONCE per member and reused (PCA + cardinal
  // slicing). `mesh` caches it; `getFaces()` lazily populates it.
  let mesh: BrepFace[] | undefined;
  let usedMesh = false;
  const getFaces = (): BrepFace[] => {
    if (mesh === undefined) mesh = collectBodyFaces(api, modelID, element);
    if (mesh.length > 0) usedMesh = true;
    return mesh;
  };

  const wantMesh =
    cheapPrimary?.source === "axis-circle" ||
    (!cheapPrimary && opts.allowMesh) ||
    (opts.forceMeshCrossCheck === true && (!!cheapPrimary || opts.allowMesh));
  if (wantMesh) {
    const faces = getFaces();
    if (faces.length > 0) {
      const pca = tryMeshPca(faces);
      // Only admit the mesh-PCA candidate as a selectable PRIMARY when mesh
      // fallback is enabled; otherwise keep it solely as a cross-check reference
      // so Autodesk-mode primary selection stays byte-for-byte as before.
      if (pca && (opts.allowMesh || cheapPrimary)) candidates.push(pca);
    }
  }

  const primary = pickPrimary(candidates);
  if (!primary) return null;

  // 3. Primary → world geometry.
  const matrix = multiply(placementMatrix, primary.extraMatrix);
  let start = transformPoint(matrix, primary.localStart);
  let end = transformPoint(matrix, primary.localEnd);
  let curve = primary.curve ? worldCurve(matrix, primary.curve) : undefined;

  // 4. Cardinal-offset correction for a curved primary (reuses the one mesh).
  if (curve) {
    const worldVerts = brepWorldVertices(getFaces(), placementMatrix);
    const offset = curvedCentroidOffset(worldVerts, curve);
    if (offset) {
      start = add(start, offset);
      end = add(end, offset);
      curve = { ...curve, center: add(curve.center, offset) };
    }
  }

  const tangentStart = primary.localTangentStart ? transformDirection(matrix, primary.localTangentStart) : undefined;
  const tangentEnd = primary.localTangentEnd ? transformDirection(matrix, primary.localTangentEnd) : undefined;

  // 5. Cross-check: primary vs the best-priority alternative that also resolved.
  const alternatives = candidates.filter((c) => c !== primary).sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source]);
  let agreementMm: number | undefined;
  if (alternatives.length > 0) {
    const alt = alternatives[0];
    const am = multiply(placementMatrix, alt.extraMatrix);
    agreementMm =
      Math.round(centerlineDisagreement(start, end, transformPoint(am, alt.localStart), transformPoint(am, alt.localEnd)) * 10) / 10;
  }

  return {
    start,
    end,
    curve,
    tangentStart,
    tangentEnd,
    placementMatrix,
    source: primary.source,
    agreementMm,
    alternativeSources: alternatives.map((a) => a.source),
    usedMesh,
  };
}
