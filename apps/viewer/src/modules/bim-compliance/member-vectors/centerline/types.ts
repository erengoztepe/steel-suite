/**
 * Shared data shapes for the centerline resolver — the layer that turns a raw
 * IFC beam/column/member into a single trustworthy centerline (straight
 * endpoints or a circular arc), choosing among several extraction STRATEGIES
 * and cross-checking them. See `resolver.ts` for the planner and
 * `axis-strategies.ts` / `body-strategies.ts` / `cardinal-correction.ts` for
 * the individual methods.
 */

import type { Mat4 } from "../ifc-core";

type Vec3 = [number, number, number];

/**
 * A circular arc in a 3D frame (LOCAL = pre-placement, or WORLD after it):
 * point(θ) = center + radius·(cosθ·xAxis + sinθ·yAxis), trimmed to
 * [theta1, theta2] (radians). theta1/theta2 follow Trim1/Trim2 as given — NOT
 * necessarily theta1 < theta2 — so theta1 corresponds to `localStart`, theta2
 * to `localEnd`.
 */
export interface CircleAxisCurve {
  center: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  radius: number;
  theta1: number;
  theta2: number;
}

/** Which extraction strategy produced a centerline candidate. */
export type CenterlineSource =
  | "axis-polyline" // IfcPolyline Axis — straight
  | "axis-line" // IfcTrimmedCurve on IfcLine — straight
  | "axis-circle" // IfcTrimmedCurve on IfcCircle — curved arc
  | "body-extrusion" // IfcExtrudedAreaSolid body (no Axis) — straight
  | "mesh-pca"; // triangulated Brep body, PCA fit — straight + near-joint tangents

/**
 * A member's centerline in its LOCAL frame (before `extraMatrix`/placement),
 * as produced by one strategy.
 */
export interface LocalAxisPoints {
  localStart: Vec3;
  localEnd: Vec3;
  /** Extra transform (from IfcMappedItem.MappingTarget) to apply before the object's own placement. */
  extraMatrix: Mat4;
  /**
   * Local tangent fit only from geometry near that one cap (mesh-PCA only) —
   * set when the mesh is bent enough that this differs meaningfully from the
   * whole-length chord. A bent Tekla brace's joint-side connection angle is
   * this local tangent, not the average slope. Undefined for straight members.
   */
  localTangentStart?: Vec3;
  localTangentEnd?: Vec3;
  /**
   * Exact analytic centerline (IfcTrimmedCurve on IfcCircle) — a real curved
   * member. Lets the joint solver use the point ON THE CURVE nearest the joint
   * and its tangent, instead of assuming the joint is at a physical end.
   */
  curve?: CircleAxisCurve;
}

/** A candidate = one strategy's {@link LocalAxisPoints} tagged with its source + cost. */
export interface CenterlineCandidate extends LocalAxisPoints {
  source: CenterlineSource;
  /** true when producing this required extracting the Body mesh (the expensive path). */
  usesMesh: boolean;
}

/**
 * The resolver's output for one member: WORLD-space centerline (centroid-
 * corrected for curved members) + which method was used + how well the
 * applicable methods agreed. `placementMatrix` (the object's own frame,
 * WITHOUT the Axis mapped-item transform) is returned because the caller still
 * needs it for the local-X/Y/Z rotation frame.
 */
export interface ResolvedCenterline {
  start: Vec3;
  end: Vec3;
  curve?: CircleAxisCurve;
  tangentStart?: Vec3;
  tangentEnd?: Vec3;
  placementMatrix: Mat4;
  source: CenterlineSource;
  /**
   * Max endpoint disagreement (mm) between the chosen method and the best
   * comparable alternative — undefined when only one method was applicable.
   * A large value flags a member whose extraction methods disagree (QA hint;
   * also the future basis for auto-selecting the method without a toggle).
   */
  agreementMm?: number;
  /** Alternative sources that also produced a candidate (for QA/diagnostics). */
  alternativeSources: CenterlineSource[];
  /** Whether the Body mesh had to be extracted (perf diagnostics). */
  usedMesh: boolean;
}
