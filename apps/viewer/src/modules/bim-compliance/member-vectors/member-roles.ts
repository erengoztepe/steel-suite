/**
 * Member role classification + shared colour palette, used by both the 2D
 * schematic (joint-diagram) and the 3D viewer overlay (draw-vectors) so the two
 * views read consistently.
 */

export type MemberRole = "column" | "beam" | "brace";

/** Classify by the close→far unit direction (IFC Z-up). */
export function memberRole(unit: [number, number, number]): MemberRole {
  const uz = Math.abs(unit[2]);
  if (uz > 0.7) return "column"; // predominantly vertical
  const ux = Math.abs(unit[0]);
  const uy = Math.abs(unit[1]);
  if (uz < 0.3 && (ux > 0.95 || uy > 0.95)) return "beam"; // horizontal, axis-aligned
  return "brace"; // diagonal / everything else
}

export const ROLE_HEX: Record<MemberRole, string> = {
  column: "#4f8ff0",
  beam: "#2fb6a8",
  brace: "#8aa0b2",
};

export const BEARING_HEX = "#f5a623";
export const NODE_HEX = "#22d3ee";

export const ROLE_COLOR_NUM: Record<MemberRole, number> = {
  column: 0x4f8ff0,
  beam: 0x2fb6a8,
  brace: 0x8aa0b2,
};
export const BEARING_COLOR_NUM = 0xf5a623;
export const NODE_COLOR_NUM = 0x22d3ee;
