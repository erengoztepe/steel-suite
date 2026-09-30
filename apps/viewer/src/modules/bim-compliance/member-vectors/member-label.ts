/**
 * Shared "(N) identifier" label convention for a selected member, used
 * consistently across the on-screen viewer labels, the joint table, and the
 * right-side selection list — so a member always reads the same way no
 * matter where it's shown.
 *
 * `index` is the member's position in the *selection order* (0-based).
 *
 * Tekla's Tag field on IfcMember is commonly a non-identifying placeholder
 * (e.g. "P/0(?)") shared by many members, so Tekla-sourced models show
 * GlobalId instead; Autodesk-sourced models show Tag (the identifying field
 * there), falling back to the other identifier when empty.
 */
export function formatMemberLabel(
  index: number,
  ifcSource: "tekla" | "autodesk",
  globalId: string,
  tag: string,
): string {
  const value = ifcSource === "tekla" ? globalId || tag || "—" : tag || globalId || "—";
  return `(${index + 1}) ${value}`;
}
