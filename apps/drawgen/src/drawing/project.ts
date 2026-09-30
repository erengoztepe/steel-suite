// Orthographic projection of 3D points onto a 2D view plane.

import type { Vec3, Pt2 } from '../model/types.ts';

/** A view plane: in-plane orthonormal basis (u, v) anchored at `origin`. */
export interface ViewFrame {
  origin: Vec3;
  u: Vec3; // maps to drawing +X
  v: Vec3; // maps to drawing +Y
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Project a global 3D point into the view frame's 2D coordinates (mm). */
export function project(p: Vec3, f: ViewFrame): Pt2 {
  const d = sub(p, f.origin);
  return { x: dot(d, f.u), y: dot(d, f.v) };
}

export const pt2tuple = (p: Pt2): [number, number] => [p.x, p.y];
