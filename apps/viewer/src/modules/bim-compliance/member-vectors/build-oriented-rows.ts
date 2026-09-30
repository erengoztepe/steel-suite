/**
 * Build display rows from the joint solution: vectors point close→far
 * (deterministic; no auto-flip needed), start/end become close/far, and each row
 * carries its eccentricity `offset` (close − node). A manual flip is still
 * available as an override. Falls back to raw geometry if the joint is unsolved.
 *
 * `bearingGlobalId` is the single member the node is anchored to (offsetLocal
 * zero); `geomTypeById` is the independent per-member Continuous/Ended
 * geometrical type (IOM `IsContinuous`).
 *
 * Extracted from the panel so headless tooling (e.g. tools/idea, which re-emits
 * IOM from a saved connection) reconstructs oriented rows through the EXACT same
 * path the viewer uses — no logic duplication, no drift. This module is pure
 * (no React/DOM/three), so it runs under Node/tsx as well as in the browser.
 */
import type { JointSolution, Vec3 } from "./joint-solver";
import type { MemberVectorRow, OrientedMemberVectorRow } from "./types";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function buildOrientedRows(
  rows: MemberVectorRow[],
  solution: JointSolution | null,
  bearingGlobalId: string | null,
  geomTypeById: Map<string, "Continuous" | "Ended">,
  manualFlips: Set<string>,
): OrientedMemberVectorRow[] {
  const refId = bearingGlobalId ?? rows[0]?.globalId ?? null;
  const byId = new Map(solution?.members.map((s) => [s.globalId, s]));

  const node = solution?.node;

  return rows.map((row) => {
    const isBearing = row.globalId === refId;
    const isContinuous = geomTypeById.get(row.globalId) === "Continuous";
    const s = byId.get(row.globalId);
    if (!s) {
      return {
        ...row,
        flipped: false,
        isContinuous,
        isBearing,
        offset: [0, 0, 0] as Vec3,
        eccentricityMm: 0,
        offsetLocal: [0, 0, 0] as Vec3,
      };
    }
    const flip = manualFlips.has(row.globalId);
    let vec: Vec3 = [s.far[0] - s.close[0], s.far[1] - s.close[1], s.far[2] - s.close[2]];
    let unit: Vec3 = [...s.orientedUnit];
    if (flip) {
      vec = [-vec[0], -vec[1], -vec[2]];
      unit = [-unit[0], -unit[1], -unit[2]];
    }
    // Offset in the member's local frame, perpendicular components only:
    // [0, ey, ez] = [0, localYᵀ·(close − node), localZᵀ·(close − node)]. The
    // along-axis component (ex) is not computed — IDEA trims the member freely
    // along its own axis, so it carries no structural meaning. The bearing
    // member is defined as (0,0,0).
    let offsetLocal: Vec3 = [0, 0, 0];
    if (!isBearing && node) {
      const g: Vec3 = [s.close[0] - node[0], s.close[1] - node[1], s.close[2] - node[2]];
      const d = (a: Vec3) => a[0] * g[0] + a[1] * g[1] + a[2] * g[2];
      offsetLocal = [0, r3(d(row.localY)), r3(d(row.localZ))];
    }
    return {
      ...row,
      // start = close (joint side), end = far — aligned with the close→far convention.
      start: [r3(s.close[0]), r3(s.close[1]), r3(s.close[2])],
      end: [r3(s.far[0]), r3(s.far[1]), r3(s.far[2])],
      vector: [r3(vec[0]), r3(vec[1]), r3(vec[2])],
      unit: [r4(unit[0]), r4(unit[1]), r4(unit[2])],
      offset: [r3(s.offset[0]), r3(s.offset[1]), r3(s.offset[2])],
      eccentricityMm: Math.round(s.eccentricity * 10) / 10,
      offsetLocal,
      flipped: flip,
      isContinuous,
      isBearing,
    };
  });
}
