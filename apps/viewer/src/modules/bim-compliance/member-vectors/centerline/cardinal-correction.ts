/**
 * Cardinal-point (insertion-point) correction for CURVED members.
 *
 * A curved member's IFC "Axis" circle is often drawn at a non-centroidal
 * reference (Tekla/Revit insertion point), commonly ~half the section depth off
 * — so it misses where framing members actually meet and inflates every joint
 * eccentricity. This module measures the true section-centroid centerline from
 * the body mesh and returns the constant translation that moves the Axis circle
 * onto it. Straight members and parametric bodies need no correction (their
 * axis already sits on the centroid).
 */

import { cross, GLOBAL_UP, normalize } from "../ifc-core";
import type { CircleAxisCurve } from "./types";

type Vec3 = [number, number, number];

const centroidPointAt = (c: CircleAxisCurve, t: number): Vec3 => [
  c.center[0] + c.radius * (Math.cos(t) * c.xAxis[0] + Math.sin(t) * c.yAxis[0]),
  c.center[1] + c.radius * (Math.cos(t) * c.xAxis[1] + Math.sin(t) * c.yAxis[1]),
  c.center[2] + c.radius * (Math.cos(t) * c.xAxis[2] + Math.sin(t) * c.yAxis[2]),
];
const centroidTangentAt = (c: CircleAxisCurve, t: number): Vec3 =>
  normalize([
    -Math.sin(t) * c.xAxis[0] + Math.cos(t) * c.yAxis[0],
    -Math.sin(t) * c.xAxis[1] + Math.cos(t) * c.yAxis[1],
    -Math.sin(t) * c.xAxis[2] + Math.cos(t) * c.yAxis[2],
  ]) as Vec3;

/** Below this (mm) the axis is already ~centroidal — leave the curve untouched (no-op for well-centered members). */
const MIN_CARDINAL_OFFSET_MM = 5;

/**
 * The constant translation (world vector) that moves a curved member's WORLD
 * `curve` onto its true SECTION-CENTROID centerline.
 *
 * Method (tangent-guided orthogonal slicing — the standard curve-skeleton
 * primitive): at K stations along the arc, slice the body mesh with the plane
 * through the axis point ⊥ the arc's local tangent, take the section's centroid
 * as the bounding-box centre of the slab's vertices IN THAT PLANE (exact for a
 * doubly-symmetric steel section, and unbiased by uneven vertex density — a
 * plain vertex mean is pulled toward the flanges), and average the per-station
 * axis→centroid offset. Using the analytic circle's own tangent for the cutting
 * plane keeps the slices orthogonal to the true length direction even at high
 * curvature (a whole-member PCA axis would not). Returns null when the body has
 * no mesh (parametric solids are already centroidal), too few stations resolve,
 * the offset is negligible, or the per-station offset is too inconsistent.
 *
 * LIMITATION: the bbox-centre = centroid identity holds for DOUBLY-SYMMETRIC
 * sections (I / CHS / box / RHS — every curved member in the target models).
 * For a singly-/un-symmetric curved section (channel, angle, T, plate girder
 * with a continuous one-sided plate) the bbox centre differs from the true area
 * centroid by tens of mm. If such sections appear, replace the bbox centre here
 * with the area centroid of the actual section polygon (slice-plane ∩ mesh faces).
 */
export function curvedCentroidOffset(worldVerts: Vec3[], curve: CircleAxisCurve): Vec3 | null {
  if (worldVerts.length < 24) return null;
  const K = 48;
  const arcLen = curve.radius * Math.abs(curve.theta2 - curve.theta1);
  const slabHalf = Math.max(arcLen / K, 120); // ~ station spacing, floored above the mesh ring spacing
  const offsets: Vec3[] = [];
  for (let i = 0; i <= K; i++) {
    const t = curve.theta1 + ((curve.theta2 - curve.theta1) * i) / K;
    const P = centroidPointAt(curve, t);
    const T = centroidTangentAt(curve, t);
    // Two orthonormal in-plane axes ⊥ T.
    let u = cross(T, GLOBAL_UP);
    if (Math.hypot(u[0], u[1], u[2]) < 1e-6) u = cross(T, [1, 0, 0]);
    u = normalize(u);
    const w = normalize(cross(T, u));
    let uMin = Infinity, uMax = -Infinity, wMin = Infinity, wMax = -Infinity, cnt = 0;
    for (const v of worldVerts) {
      const dx = v[0] - P[0], dy = v[1] - P[1], dz = v[2] - P[2];
      if (Math.abs(dx * T[0] + dy * T[1] + dz * T[2]) >= slabHalf) continue;
      const du = dx * u[0] + dy * u[1] + dz * u[2];
      const dw = dx * w[0] + dy * w[1] + dz * w[2];
      if (du < uMin) uMin = du; if (du > uMax) uMax = du;
      if (dw < wMin) wMin = dw; if (dw > wMax) wMax = dw;
      cnt++;
    }
    if (cnt < 6) continue;
    const uc = (uMin + uMax) / 2, wc = (wMin + wMax) / 2;
    offsets.push([uc * u[0] + wc * w[0], uc * u[1] + wc * w[1], uc * u[2] + wc * w[2]]);
  }
  if (offsets.length < 5) return null;
  const avg: Vec3 = [0, 0, 0];
  for (const o of offsets) { avg[0] += o[0]; avg[1] += o[1]; avg[2] += o[2]; }
  avg[0] /= offsets.length; avg[1] /= offsets.length; avg[2] /= offsets.length;
  const mag = Math.hypot(avg[0], avg[1], avg[2]);
  if (mag < MIN_CARDINAL_OFFSET_MM) return null;
  // Consistency guard: a wildly varying per-station offset means the slab is
  // catching the wrong geometry (clips, gussets) — don't trust a single shift.
  let varSum = 0;
  for (const o of offsets) varSum += (o[0] - avg[0]) ** 2 + (o[1] - avg[1]) ** 2 + (o[2] - avg[2]) ** 2;
  const stddev = Math.sqrt(varSum / offsets.length);
  if (stddev > mag) return null;
  return avg;
}
