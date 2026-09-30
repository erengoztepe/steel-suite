// Steel cross-section outlines from IOM parametric dimensions (mm).
// Returned points are in a local 2D frame: +x = width (along section vy),
// +y = height (along section vz), centred on the centroid. (Fillet radii omitted
// in v1 -- sharp web/flange junctions.)

import type { Pt2 } from '../model/types.ts';

/** Rolled I / H section outline (12-pt), centred at origin. */
export function rolledIOutline(B: number, H: number, tw: number, tf: number): Pt2[] {
  const b = B / 2, h = H / 2, w = tw / 2;
  const yi = h - tf; // inner flange face
  return [
    { x: -b, y: h }, { x: b, y: h }, { x: b, y: yi },
    { x: w, y: yi }, { x: w, y: -yi }, { x: b, y: -yi },
    { x: b, y: -h }, { x: -b, y: -h }, { x: -b, y: -yi },
    { x: -w, y: -yi }, { x: -w, y: yi }, { x: -b, y: yi },
  ];
}

/** Does this section type render as an I/H outline? */
export function isIShape(type: string): boolean {
  return /RolledI|WeldedI|I|H/i.test(type);
}
