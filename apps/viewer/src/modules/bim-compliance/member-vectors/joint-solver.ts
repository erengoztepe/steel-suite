/**
 * Joint solver — reconstructs the IDEA connection work-point and per-member
 * eccentricity from the selected members' axis geometry, per the structural
 * spec (Eren):
 *
 *  1. Treat each member as an infinite 3D line (point pᵢ, unit dir dᵢ). Find the
 *     virtual joint P minimizing the sum of squared perpendicular distances to
 *     all lines (Closest Point of Approach) via Linear Least Squares:
 *        Mᵢ = I − dᵢdᵢᵀ            (projection onto the plane ⊥ dᵢ)
 *        (Σ Mᵢ) P = Σ Mᵢ pᵢ  ⇒  A·P = B
 *        P = A⁺·B                 (Moore-Penrose pseudo-inverse — robust when
 *                                  lines are parallel/collinear and A is singular)
 *  2. Classify each member's endpoints: the one nearer P is the "close end"
 *     (at the joint), the other is the "far end".
 *  3. Node = centroid of the close ends → the IDEA connection node.
 *  4. Per-member offset = closeEnd − node (eccentricity; the X/Y/Z offset that
 *     places the member's reference line at its real end relative to the node).
 *  5. Oriented direction = normalize(far − close): every vector points
 *     close→far (out of the joint), deterministically — no manual flipping.
 *
 * All coordinates are in the input units (we pass IFC mm); the solver is
 * unit-agnostic. Pure and dependency-free so it can be unit-tested and reused by
 * both the results table and the IOM exporter.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

/** A circular arc: point(θ) = center + radius·(cosθ·xAxis + sinθ·yAxis), trimmed to [theta1, theta2] (radians). */
export interface JointMemberCurve {
  center: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  radius: number;
  theta1: number;
  theta2: number;
}

export interface JointMemberInput {
  globalId: string;
  start: Vec3;
  end: Vec3;
  /** Unit axis direction (sign irrelevant for CPA). */
  unit: Vec3;
  /**
   * Local tangent fit only from geometry near `start`/`end` respectively —
   * set only for bent/curved members (Tekla Brep-PCA fallback). When the end
   * classified as "close" (at the joint) has one, `orientedUnit` below prefers
   * it over the whole-length chord: a bent member's connection angle is the
   * tangent where it frames into the joint, not its average slope. Undefined
   * for straight members, where chord and tangent coincide anyway.
   */
  tangentStart?: Vec3;
  tangentEnd?: Vec3;
  /**
   * Exact analytic centerline, set only when the Axis representation is an
   * IfcTrimmedCurve on an IfcCircle. Takes priority over `tangentStart`/
   * `tangentEnd`: instead of assuming the joint sits at one of this member's
   * own two ends (wrong for a member running continuously THROUGH the joint —
   * e.g. a curved chord with several joints along its length), the solver
   * finds the point ON THE CURVE nearest the CPA and uses the curve's own
   * tangent there.
   */
  curve?: JointMemberCurve;
}

export interface JointMemberSolution {
  globalId: string;
  /** Endpoint at the joint (nearer to the CPA point). */
  close: Vec3;
  /** Endpoint away from the joint. */
  far: Vec3;
  /** Unit direction close→far (out of the joint). */
  orientedUnit: Vec3;
  /** Raw endpoint delta close − node (same units as input). Positions the member; mixes along-axis + perpendicular. */
  offset: Vec3;
  /**
   * Structural eccentricity: the PERPENDICULAR distance from the node to this
   * member's axis line (same units as input). This is the moment arm — a member
   * axis that misses the node by `e` under axial force N produces a secondary
   * moment N·e. The along-axis part of `offset` produces no moment, so this
   * (not |offset|) is the meaningful "how far does it miss the joint" number.
   */
  eccentricity: number;
  /** Which original endpoint was the close end ("start" | "end"). */
  closeIs: "start" | "end";
}

export interface JointSolution {
  /** Least-squares virtual joint (Closest Point of Approach). */
  cpa: Vec3;
  /** Connection node = centroid of the close ends. */
  node: Vec3;
  members: JointMemberSolution[];
  /**
   * Only set by {@link anchorNodeToBearing}: the perpendicular distance (same
   * units as input) between where the ATTACHED members converge and the bearing
   * member's axis — i.e. how far the bearing axis misses the web crossing that
   * the node was projected onto. ~0 for a clean joint; a large value means the
   * chosen bearing member doesn't actually pass through where the others meet
   * (wrong bearing pick, or a genuinely eccentric connection). Undefined when
   * the node is the plain democratic CPA (no bearing anchoring).
   */
  bearingOffsetMm?: number;
}

// ---------------------------------------------------------------------------
// vector helpers
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function distSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------
// symmetric 3×3 eigen-decomposition (Jacobi) → Moore-Penrose pseudo-inverse
// ---------------------------------------------------------------------------

/**
 * Jacobi eigenvalue algorithm for a symmetric 3×3 matrix.
 * Returns eigenvalues and eigenvectors (columns of V). Iterates until the
 * off-diagonal norm is negligible (3×3 converges in a handful of sweeps).
 */
export function jacobiEigenSym3(a: Mat3): { values: [number, number, number]; vectors: Mat3 } {
  // Work on a mutable copy of the (symmetric) matrix.
  const A = a.slice() as Mat3;
  // V starts as identity (eigenvectors as columns).
  const V: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const idx = (r: number, c: number) => r * 3 + c;

  for (let sweep = 0; sweep < 50; sweep++) {
    // Largest off-diagonal magnitude.
    const off = Math.abs(A[idx(0, 1)]) + Math.abs(A[idx(0, 2)]) + Math.abs(A[idx(1, 2)]);
    if (off < 1e-18) break;

    // Rotate to zero each off-diagonal (p,q) in {(0,1),(0,2),(1,2)}.
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = A[idx(p, q)];
      if (Math.abs(apq) < 1e-20) continue;
      const app = A[idx(p, p)];
      const aqq = A[idx(q, q)];
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi);
      const s = Math.sin(phi);

      // Apply rotation J^T A J.
      for (let k = 0; k < 3; k++) {
        const akp = A[idx(k, p)];
        const akq = A[idx(k, q)];
        A[idx(k, p)] = c * akp - s * akq;
        A[idx(k, q)] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[idx(p, k)];
        const aqk = A[idx(q, k)];
        A[idx(p, k)] = c * apk - s * aqk;
        A[idx(q, k)] = s * apk + c * aqk;
      }
      // Accumulate eigenvectors.
      for (let k = 0; k < 3; k++) {
        const vkp = V[idx(k, p)];
        const vkq = V[idx(k, q)];
        V[idx(k, p)] = c * vkp - s * vkq;
        V[idx(k, q)] = s * vkp + c * vkq;
      }
    }
  }

  return { values: [A[idx(0, 0)], A[idx(1, 1)], A[idx(2, 2)]], vectors: V };
}

/**
 * Moore-Penrose pseudo-inverse of a symmetric 3×3 matrix via eigen-decomposition:
 * A⁺ = Σ (1/λⱼ) vⱼ vⱼᵀ over eigenvalues with |λ| above a relative tolerance
 * (drops the null space → handles singular A from parallel/collinear lines).
 */
function pseudoInverseSym3(a: Mat3): Mat3 {
  const { values, vectors } = jacobiEigenSym3(a);
  const maxAbs = Math.max(Math.abs(values[0]), Math.abs(values[1]), Math.abs(values[2]), 1e-300);
  const tol = maxAbs * 1e-12;
  const out: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const idx = (r: number, c: number) => r * 3 + c;
  for (let j = 0; j < 3; j++) {
    const lambda = values[j];
    if (Math.abs(lambda) <= tol) continue; // null space contribution dropped
    const inv = 1 / lambda;
    // eigenvector j = column j of V
    const vx = vectors[idx(0, j)];
    const vy = vectors[idx(1, j)];
    const vz = vectors[idx(2, j)];
    const col: Vec3 = [vx, vy, vz];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        out[idx(r, c)] += inv * col[r] * col[c];
      }
    }
  }
  return out;
}

function matVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// ---------------------------------------------------------------------------
// solver
// ---------------------------------------------------------------------------

/**
 * Accumulate the Linear-Least-Squares normal-equation terms A = Σ (I − dᵢdᵢᵀ)
 * and B = Σ (I − dᵢdᵢᵀ) pᵢ for a set of member axis *lines* (point pᵢ, unit
 * dᵢ). The free minimizer of Σ (perpendicular distance to line i)² is A⁺·B
 * ({@link leastSquaresCpa}); a minimizer constrained to a 1D axis reuses the
 * same A/B (see {@link anchorNodeToBearing}). Members with no usable direction
 * are skipped (contribute nothing).
 */
/**
 * The (point, unit) pair to treat a member as an infinite LINE for CPA fitting.
 * A circular arc isn't a line — its chord (mem.start, mem.unit) can sit METRES
 * off the true curve at the arc's midpoint (sagitta = r·(1 − cos(halfAngle)),
 * ~2 m for an 85 m-radius, 25° arc here) — a poor proxy right where a joint
 * usually sits. When a `referencePoint` estimate of the joint is available,
 * curved members instead use the curve's own tangent LINE at the point on the
 * curve nearest that estimate — the correct local linearization, given a
 * decent joint estimate to linearize around. Falls back to the chord when
 * there's no estimate yet (first pass) or the member isn't curved.
 */
function effectiveLine(mem: JointMemberInput, referencePoint: Vec3 | null): { point: Vec3; unit: Vec3 } {
  if (mem.curve && referencePoint) {
    const proj = projectOntoCircle(mem.curve, referencePoint);
    return { point: proj.point, unit: proj.tangent };
  }
  return { point: mem.start, unit: mem.unit };
}

function accumulateLineLS(members: JointMemberInput[], referencePoint: Vec3 | null): { A: Mat3; B: Vec3 } {
  const usable = members.filter((m) => Math.hypot(m.unit[0], m.unit[1], m.unit[2]) > 1e-9);

  const A: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let B: Vec3 = [0, 0, 0];

  for (const mem of usable) {
    const { point: p, unit } = effectiveLine(mem, referencePoint);
    const d = normalize(unit);
    // Mᵢ = I − ddᵀ
    const M: Mat3 = [
      1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2],
      -d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2],
      -d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2],
    ];
    for (let i = 0; i < 9; i++) A[i] += M[i];
    const Mp = matVec3(M, p);
    B = [B[0] + Mp[0], B[1] + Mp[1], B[2] + Mp[2]];
  }

  return { A, B };
}

/**
 * Closest Point of Approach of a set of member axis *lines* via Linear Least
 * Squares: the point minimizing Σ (perpendicular distance to line i)². Returns
 * null when fewer than 2 members carry a usable direction. Shared by the full
 * joint solve and the attached-only convergence used for bearing anchoring.
 * `referencePoint` (see {@link effectiveLine}) lets curved members linearize
 * around a current joint estimate instead of their whole-length chord.
 */
function leastSquaresCpa(members: JointMemberInput[], referencePoint: Vec3 | null): Vec3 | null {
  const usable = members.filter((m) => Math.hypot(m.unit[0], m.unit[1], m.unit[2]) > 1e-9);
  if (usable.length < 2) return null;

  const { A, B } = accumulateLineLS(members, referencePoint);
  return matVec3(pseudoInverseSym3(A), B);
}

/** Orthogonal projection of `point` onto the infinite line (linePoint, unit). */
function projectOntoLine(point: Vec3, linePoint: Vec3, unit: Vec3): Vec3 {
  const w = sub(point, linePoint);
  const t = dot(w, unit);
  return [linePoint[0] + t * unit[0], linePoint[1] + t * unit[1], linePoint[2] + t * unit[2]];
}

/**
 * Nearest point on a (trimmed) circular arc to `point`, plus the curve's own
 * tangent direction there — the generalization of "which end is at the joint"
 * for a member that runs continuously THROUGH the joint, where neither
 * physical end is anywhere near it.
 *
 * Projects `point` onto the circle's plane, reads off its angle, then clamps
 * into the trim range: `theta` is shifted by whole turns first so it lands
 * next to [lo, hi] rather than wrapping the "wrong way" around — correct as
 * long as the trimmed arc itself spans less than a full turn (true for every
 * real structural member).
 */
/** Point + unit tangent on the circle at parameter `theta` (radians), UNCLAMPED. */
function curvePointAt(curve: JointMemberCurve, theta: number): { point: Vec3; tangent: Vec3 } {
  const { center, xAxis, yAxis, radius } = curve;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const point: Vec3 = [
    center[0] + radius * (c * xAxis[0] + s * yAxis[0]),
    center[1] + radius * (c * xAxis[1] + s * yAxis[1]),
    center[2] + radius * (c * xAxis[2] + s * yAxis[2]),
  ];
  const tangent = normalize([-s * xAxis[0] + c * yAxis[0], -s * xAxis[1] + c * yAxis[1], -s * xAxis[2] + c * yAxis[2]]);
  return { point, tangent };
}

/**
 * Shift `theta` by whole turns to the representative nearest the arc's MIDPOINT,
 * then clamp into [lo, hi]. Anchoring the wrap window on the midpoint (not an
 * endpoint) keeps both ends reachable and assigns the far-side gap to the true
 * nearest end for any arc spanning up to a full turn — a naive lo-anchored
 * window leaves the hi end unreachable once the span exceeds 180°.
 */
function clampThetaToCurve(curve: JointMemberCurve, theta: number): number {
  const lo = Math.min(curve.theta1, curve.theta2);
  const hi = Math.max(curve.theta1, curve.theta2);
  const mid = (lo + hi) / 2;
  const twoPi = Math.PI * 2;
  let t = theta;
  while (t < mid - Math.PI) t += twoPi;
  while (t > mid + Math.PI) t -= twoPi;
  return Math.max(lo, Math.min(hi, t));
}

/**
 * Nearest point on a (trimmed) circular arc to `point`, plus the curve's own
 * tangent direction (and parameter) there — the generalization of "which end
 * is at the joint" for a member that runs continuously THROUGH the joint,
 * where neither physical end is anywhere near it.
 */
function projectOntoCircle(curve: JointMemberCurve, point: Vec3): { point: Vec3; tangent: Vec3; theta: number } {
  const v = sub(point, curve.center);
  const theta = clampThetaToCurve(curve, Math.atan2(dot(v, curve.yAxis), dot(v, curve.xAxis)));
  return { ...curvePointAt(curve, theta), theta };
}

/** Perpendicular distance from `node` to member `m`, given its oriented unit. */
function perpDistance(closeToNode: Vec3, unit: Vec3): number {
  const along = dot(closeToNode, unit);
  const perp: Vec3 = [
    closeToNode[0] - along * unit[0],
    closeToNode[1] - along * unit[1],
    closeToNode[2] - along * unit[2],
  ];
  return Math.hypot(perp[0], perp[1], perp[2]);
}

/**
 * Solve the joint from the selected members' axis geometry.
 * Returns null when there are fewer than 2 usable members.
 */
export function solveJoint(members: JointMemberInput[]): JointSolution | null {
  let cpa = leastSquaresCpa(members, null);
  if (!cpa) return null;

  // Curved member(s): the first pass above linearized them as their whole-length
  // chord (no joint estimate existed yet) — re-fit using each curve's own local
  // tangent LINE at the current best joint estimate, a couple of times, so the
  // linearization used for the fit matches the region actually near the joint
  // (a fixed-point iteration; converges quickly since real member curvature is
  // mild/monotonic — 4 passes is comfortably enough headroom).
  if (members.some((m) => m.curve)) {
    for (let iter = 0; iter < 4; iter++) {
      const next = leastSquaresCpa(members, cpa);
      if (!next) break;
      const moved = distSq(next, cpa);
      cpa = next;
      if (moved < 1) break; // < 1mm shift: converged
    }
  }

  // Classify close/far by proximity to the CPA point.
  const solved: JointMemberSolution[] = members.map((mem) => {
    const startCloser = distSq(mem.start, cpa) <= distSq(mem.end, cpa);
    const far = startCloser ? mem.end : mem.start;

    if (mem.curve) {
      // Continuous curved member: the joint may sit anywhere along the arc,
      // not at either physical end (e.g. a curved chord with several joints
      // along its length). Use the point ON THE CURVE nearest the CPA — and
      // the curve's own tangent there — instead of a true endpoint.
      const proj = projectOntoCircle(mem.curve, cpa);
      const chordUnit = normalize(sub(far, proj.point));
      const orientedUnit = dot(proj.tangent, chordUnit) >= 0 ? proj.tangent : ([-proj.tangent[0], -proj.tangent[1], -proj.tangent[2]] as Vec3);
      return {
        globalId: mem.globalId,
        close: proj.point,
        far,
        orientedUnit,
        offset: [0, 0, 0], // filled after node is known
        eccentricity: 0, // filled after node is known
        closeIs: startCloser ? "start" : "end",
      };
    }

    const close = startCloser ? mem.start : mem.end;
    const chordUnit = normalize(sub(far, close));

    // Bent member: prefer the near-joint local tangent (fit only from the
    // mesh close to this end) over the whole-length chord for the displayed
    // direction/eccentricity — oriented close→far like chordUnit, since PCA
    // gives no inherent sign.
    const closeTangent = startCloser ? mem.tangentStart : mem.tangentEnd;
    const orientedUnit =
      closeTangent && Math.hypot(closeTangent[0], closeTangent[1], closeTangent[2]) > 1e-9
        ? dot(closeTangent, chordUnit) >= 0
          ? normalize(closeTangent)
          : normalize([-closeTangent[0], -closeTangent[1], -closeTangent[2]])
        : chordUnit;

    return {
      globalId: mem.globalId,
      close,
      far,
      orientedUnit,
      offset: [0, 0, 0], // filled after node is known
      eccentricity: 0, // filled after node is known
      closeIs: startCloser ? "start" : "end",
    };
  });

  // Node = the CPA point itself. It is a least-squares fit to the member *lines*
  // (not their endpoints), so it stays at the true joint even when one member
  // runs THROUGH the joint (a long continuous column whose nearer endpoint is
  // far from where the others meet) — that outlier would drag a close-end
  // centroid off the joint, but not the CPA. For clean joints where all members
  // terminate at the node, the CPA and the close-end centroid coincide.
  const node: Vec3 = [...cpa];

  // Per member: raw offset (close − node) and the structural eccentricity =
  // perpendicular distance from the node to the member axis = |offset − (offset·û)û|.
  for (const s of solved) {
    s.offset = sub(s.close, node);
    s.eccentricity = perpDistance(s.offset, s.orientedUnit);
  }

  return { cpa, node, members: solved };
}

/**
 * Below this, attached members are considered too nearly parallel to the
 * bearing axis for the along-axis position to be well-determined: D/n is the
 * mean of sin²∠(bearing axis, attached axis) — 0.05 ≈ 13° of spread.
 */
const DEGENERATE_EPS = 0.05;

/**
 * Re-solve the joint with its node ANCHORED to a chosen bearing member's axis,
 * per IDEA StatiCa's connection convention: the work-point sits on the bearing
 * member's reference line, and every attached member is offset relative to it.
 *
 * Why this matters (the "ended bearing member" case): the plain CPA node is a
 * democratic least-squares fit to ALL axis lines. When the bearing member runs
 * THROUGH the joint the CPA already lies on its axis, so the two agree. But when
 * the bearing member is *ended* (e.g. a truss chord that terminates at the end
 * panel point), the CPA floats off the bearing axis to a compromise point — the
 * bearing then shows a spurious eccentricity and every attached member's offset
 * is measured from a node that is neither on the bearing axis nor a true meeting
 * point. Anchoring fixes this by finding the along-axis position that MINIMIZES
 * the attached members' total perpendicular distance to the node — the exact
 * constrained minimum, not an approximation:
 *
 *   1. {A, B} accumulate Σ(I − dᵢdᵢᵀ) / Σ(I − dᵢdᵢᵀ)pᵢ over the ATTACHED
 *      members (bearing excluded). For node(t) = b0 + t·u (b0 = a point on the
 *      bearing axis, u = its unit direction), the sum-of-squared-perpendicular-
 *      distances objective is minimized at t = uᵀ(B − A·b0) / uᵀAu — the
 *      derivative of the quadratic form set to zero (closed form, not a
 *      projection of the free/unconstrained CPA).
 *   2. Degenerate case: uᵀAu (scaled by attached count) measures how much the
 *      attached axes deviate from parallel to u — near zero when they're all
 *      ~parallel to the bearing, so the along-axis position is undetermined by
 *      the minimization. Falls back to projecting the centroid of the *Ended*
 *      attached members' close ends onto the bearing axis (a Continuous
 *      attached member's far end mustn't pollute this — it isn't a joint here).
 *      With no Ended attached members, falls back to b0.
 *   3. bearingOffsetMm stays the free attached-CPA's perpendicular gap to the
 *      bearing axis (diagnostic; independent of the along-axis solve above).
 *   4. every member's offset/eccentricity is recomputed from this node.
 *
 * For a continuous/through bearing member this collapses back to ≈ the CPA (no
 * regression). Returns the plain {@link solveJoint} result when no valid bearing
 * is given (null id, unknown id, or a bearing with no usable direction).
 */
export function anchorNodeToBearing(
  members: JointMemberInput[],
  bearingGlobalId: string | null,
  opts?: { endedCloseEnds?: Vec3[] },
): JointSolution | null {
  const base = solveJoint(members);
  if (!base || !bearingGlobalId) return base;

  const bearing = members.find((m) => m.globalId === bearingGlobalId);
  if (!bearing) return base;

  const bearingSolved = base.members.find((s) => s.globalId === bearingGlobalId);
  // The bearing axis to anchor along: its already-computed `orientedUnit` —
  // the near-joint tangent for a bent/curved bearing (Brep-PCA tangentStart/End,
  // or a circle-curve's local tangent at its close point), the plain chord for
  // a straight one. Using the whole-length CHORD here instead (as this used to)
  // slides the node along an axis that ISN'T where eccentricity is measured
  // against (`orientedUnit`, below and in `solveJoint`) — for a curved bearing
  // that mismatch shows up as a spurious nonzero eccentricity on the bearing
  // member itself, which by definition (it's the anchor) must be ~0.
  const u = bearingSolved ? normalize(bearingSolved.orientedUnit) : normalize(bearing.unit);
  if (Math.hypot(u[0], u[1], u[2]) < 1e-9) return base;

  // A point on the bearing axis: its joint-side (close) end from the base solve.
  const b0 = bearingSolved ? bearingSolved.close : bearing.start;

  const attached = members.filter((m) => m.globalId !== bearingGlobalId);
  const attachedUsable = attached.filter((m) => Math.hypot(m.unit[0], m.unit[1], m.unit[2]) > 1e-9);

  const degenerateNode = (atB0: Vec3, atU: Vec3): Vec3 => {
    // Degenerate: attached axes ~parallel to the bearing → tie-break on Ended
    // attached members' close-end centroid, projected onto the bearing axis.
    const endedCloseEnds = opts?.endedCloseEnds ?? [];
    if (endedCloseEnds.length === 0) return atB0;
    const sum: Vec3 = [0, 0, 0];
    for (const p of endedCloseEnds) {
      sum[0] += p[0];
      sum[1] += p[1];
      sum[2] += p[2];
    }
    const mean: Vec3 = [sum[0] / endedCloseEnds.length, sum[1] / endedCloseEnds.length, sum[2] / endedCloseEnds.length];
    return projectOntoLine(mean, atB0, atU);
  };

  let node: Vec3;
  if (attachedUsable.length === 0) {
    node = b0;
  } else if (!bearing.curve) {
    const { A, B } = accumulateLineLS(attached, base.cpa);
    const Au = matVec3(A, u);
    const D = dot(u, Au);
    if (D / attachedUsable.length >= DEGENERATE_EPS) {
      const Ab0 = matVec3(A, b0);
      const t = dot(u, sub(B, Ab0)) / D;
      node = [b0[0] + t * u[0], b0[1] + t * u[1], b0[2] + t * u[2]];
    } else {
      node = degenerateNode(b0, u);
    }
  } else {
    // Curved bearing: the (b0, u) tangent LINE is only a local proxy for the
    // real curve — a single along-axis solve that lands `t` several metres out
    // would drift off the true arc by ~t²/(2·radius) (~150 mm for a several-
    // metre slide on an 85 m-radius arc here), even though `t` is the exact
    // minimizer FOR THAT LINE. Instead walk the solve along the actual curve:
    // solve `t` (arc-length) against the current local tangent, convert to an
    // angle step (Δθ = t/radius — exact for a circle), move to the new point
    // on the curve, and re-linearize there. Converges in a few passes since
    // curvature is mild/monotonic for any real member.
    const curve = bearing.curve;
    let theta = projectOntoCircle(curve, b0).theta; // b0 is already on the curve
    // Seed the walking point/tangent from the curve's +θ parametrization (NOT
    // `u` = orientedUnit, which is signed close→far and may be anti-parallel to
    // +θ). The Δθ = t/radius step below advances +θ, so `curU` must be the +θ
    // tangent for the very first iteration to step in the correct direction —
    // seeding with a possibly-flipped `u` can send iteration 0 the wrong way and
    // spuriously trip the degeneracy test.
    const seed = curvePointAt(curve, theta);
    let curB0 = seed.point;
    let curU = seed.tangent;
    let degenerate = false;
    for (let iter = 0; iter < 8; iter++) {
      const { A, B } = accumulateLineLS(attached, curB0);
      const Au = matVec3(A, curU);
      const D = dot(curU, Au);
      if (D / attachedUsable.length < DEGENERATE_EPS) {
        degenerate = true;
        break;
      }
      const ACurB0 = matVec3(A, curB0);
      const t = dot(curU, sub(B, ACurB0)) / D;
      theta = clampThetaToCurve(curve, theta + t / curve.radius);
      const at = curvePointAt(curve, theta);
      curB0 = at.point;
      curU = at.tangent;
      if (Math.abs(t) < 1) break; // < 1mm arc-length step: converged
    }
    node = degenerate ? degenerateNode(b0, u) : curB0;
  }

  // bearingOffsetMm: perpendicular gap between the FREE attached-members
  // convergence and the bearing axis — a diagnostic, independent of the
  // along-axis node position computed above.
  let convergence: Vec3;
  if (attached.length >= 2) {
    convergence = leastSquaresCpa(attached, base.cpa) ?? base.cpa;
  } else if (attached.length === 1) {
    convergence = base.members.find((s) => s.globalId === attached[0].globalId)?.close ?? base.cpa;
  } else {
    convergence = base.cpa;
  }
  const convergenceOnAxis = projectOntoLine(convergence, b0, u);
  const bearingOffsetMm = Math.hypot(
    convergence[0] - convergenceOnAxis[0],
    convergence[1] - convergenceOnAxis[1],
    convergence[2] - convergenceOnAxis[2],
  );

  const remapped = base.members.map((s) => {
    if (s.globalId === bearingGlobalId) {
      // The node is anchored ONTO the bearing's centerline, so the bearing's own
      // eccentricity is 0 by construction. Refresh its close/orientedUnit to the
      // node itself (curved: the tangent there, keeping the close→far sign) — the
      // base solve's close sits at the pre-walk θ, several metres away for an
      // ended curved bearing, which would otherwise report a spurious sagitta-
      // sized eccentricity AND draw the bearing arrow off the node.
      if (bearing.curve) {
        const at = projectOntoCircle(bearing.curve, node);
        const oriented = dot(at.tangent, s.orientedUnit) >= 0 ? at.tangent : ([-at.tangent[0], -at.tangent[1], -at.tangent[2]] as Vec3);
        return { ...s, close: node, orientedUnit: oriented, offset: [0, 0, 0] as Vec3, eccentricity: 0 };
      }
      return { ...s, close: node, offset: [0, 0, 0] as Vec3, eccentricity: 0 };
    }
    const offset = sub(s.close, node);
    return { ...s, offset, eccentricity: perpDistance(offset, s.orientedUnit) };
  });

  return { cpa: base.cpa, node, members: remapped, bearingOffsetMm };
}
