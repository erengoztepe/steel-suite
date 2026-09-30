/**
 * Auto-suggest the "continuous"/bearing member at a joint.
 *
 * Per structural-connection theory (Eren), exactly one member at a joint is the
 * bearing member — the one that is NOT terminated and carries the others. We
 * can't read forces from IFC, so we approximate the two dominant criteria that
 * ARE derivable from geometry:
 *
 *   1. Continuity — the bearing member runs THROUGH the joint: the CPA joint
 *      point (from the joint solver) lies on its axis, well inside both ends
 *      (see {@link classifyThroughMembers}).
 *   2. Stiffness (EI/AE) — among continuous candidates, the stiffest wins
 *      (real strong-axis Iy from the IFC pset, then section area, then geometric).
 *
 * When no member runs continuously through, the joint is ambiguous: return the
 * largest-section member as a low-confidence hint (caller does NOT auto-apply).
 */

import { solveJoint } from "./joint-solver";
import type { MemberVectorRow } from "./types";

export interface BearingSuggestion {
  globalId: string;
  confidence: "high" | "low";
  reason: string;
}

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Cross-section stiffness for ranking, largest = strongest bearing candidate.
 * Prefers real strong-axis Iy (EI proxy, IFC pset), then real area (AE proxy),
 * then the geometric area fallback. 0 when nothing is known.
 */
function size(row: MemberVectorRow): number {
  if (row.iStrongCm4 != null) return row.iStrongCm4;
  if (row.sectionAreaMm2 != null) return row.sectionAreaMm2;
  return row.crossSectionArea ?? 0;
}

/**
 * How far (mm) the joint must sit inside a member, measured from its nearer
 * end, for the member to count as running THROUGH it. An Ended member still
 * overshoots the node by up to ~half the depth of what it frames into (a
 * column top rising to a beam's top flange: ~100 mm on the saved library),
 * while the shallowest real through-member there sits 392 mm in — anything in
 * ~230–390 mm separates the two. Absolute, not a fraction of the length: a
 * long column passing through near its end (t ≈ 0.09) is still continuous.
 */
const THROUGH_MARGIN_MM = 250;

/**
 * Classify which members run continuously THROUGH the joint (as opposed to
 * terminating/ending at it), against the joint's least-squares CPA point —
 * IDEA's geometrical type: Continuous = the node lies inside the member (in
 * IDEA's FEA import, a member split into two elements at the node), Ended =
 * the member has its connected end there.
 *
 * Deliberately geometric-interior ONLY. Two collinear members meeting from
 * opposite sides are two Ended members (beams framing into both sides of a
 * girder, or one line split in two) — never both Continuous: IDEA would need
 * them merged into ONE member for that, and the IOM export extends every
 * Continuous member back past the node, so flagging both emitted two
 * overlapping full-length members. That opposite-partner rule was the source
 * of most user corrections (~40 of 48 on the saved library).
 */
export function classifyThroughMembers(rows: MemberVectorRow[], cpa: Vec3): Set<string> {
  const through = new Set<string>();
  for (const r of rows) {
    const v = sub(r.end, r.start);
    const vlen2 = dot(v, v);
    if (vlen2 === 0) continue;
    const len = Math.sqrt(vlen2);
    const t = dot(sub(cpa, r.start), v) / vlen2;
    const proj: Vec3 = [r.start[0] + t * v[0], r.start[1] + t * v[1], r.start[2] + t * v[2]];
    const perp = Math.hypot(proj[0] - cpa[0], proj[1] - cpa[1], proj[2] - cpa[2]);
    const insideMm = Math.min(t, 1 - t) * len;
    if (insideMm > THROUGH_MARGIN_MM && perp < Math.max(0.05 * len, 100)) through.add(r.globalId);
  }
  return through;
}

export function suggestBearingMember(rows: MemberVectorRow[]): BearingSuggestion | null {
  if (rows.length < 2) return null;

  const sol = solveJoint(
    rows.map((r) => ({
      globalId: r.globalId,
      start: r.start,
      end: r.end,
      unit: r.unit,
      tangentStart: r.tangentStart,
      tangentEnd: r.tangentEnd,
      curve: r.curve,
    })),
  );
  if (!sol) return null;
  const cpa = sol.cpa;

  // Interior-only on purpose: an opposite-partner hint (two collinear members
  // meeting from either side) was confidently wrong on 12 of 36 saved picks —
  // those are usually the beams framing INTO the bearing, not the bearing.
  const through = classifyThroughMembers(rows, cpa);
  const throughRows = rows.filter((r) => through.has(r.globalId));
  if (throughRows.length > 0) {
    const pick = throughRows.reduce((best, r) =>
      size(r) > size(best) || (size(r) === size(best) && r.length > best.length) ? r : best,
    );
    return {
      globalId: pick.globalId,
      confidence: "high",
      reason: `Continuous through the joint with the highest stiffness${
        pick.iStrongCm4 != null ? ` (Iy ${pick.iStrongCm4} cm⁴)` : pick.crossSectionArea ? ` (${pick.crossSectionArea} mm²)` : ""
      }.`,
    };
  }

  const bySize = rows.reduce((best, r) => (size(r) > size(best) ? r : best));
  if (size(bySize) <= 0) return null;
  return {
    globalId: bySize.globalId,
    confidence: "low",
    reason: "No member runs continuously through this joint; suggesting the largest section as a guess — please confirm.",
  };
}
