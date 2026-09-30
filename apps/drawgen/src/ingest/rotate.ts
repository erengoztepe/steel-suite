// Rigid ROTATION of a ConnectionModel about the origin -- the input side of the
// rotation-invariance test (see pipeline-doctrine): the same connection fed at an arbitrary
// orientation must yield the same drawing, which only holds if every view frame is derived
// from features (member axes, plate normals), never from global axes.

import type { ConnectionModel, LCS, Vec3 } from '../model/types.ts';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rotation by `deg` about unit-ish axis (ax,ay,az) via Rodrigues. Row-major. */
export function rotationMatrix(deg: number, ax: number, ay: number, az: number): Mat3 {
  const n = Math.hypot(ax, ay, az) || 1;
  const [x, y, z] = [ax / n, ay / n, az / n];
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

const apply = (R: Mat3, v: Vec3): Vec3 => ({
  x: R[0] * v.x + R[1] * v.y + R[2] * v.z,
  y: R[3] * v.x + R[4] * v.y + R[5] * v.z,
  z: R[6] * v.x + R[7] * v.y + R[8] * v.z,
});
const rotLcs = (R: Mat3, l: LCS): LCS => ({
  origin: apply(R, l.origin), ax: apply(R, l.ax), ay: apply(R, l.ay), az: apply(R, l.az),
});

/** Return a deep-ish copy of `m` with every coordinate-bearing field rotated by R. Plate/grid
 * 2D outlines stay in their own local frames (unchanged); only the frames themselves rotate. */
export function rotateModel(m: ConnectionModel, R: Mat3): ConnectionModel {
  return {
    ...m,
    members: m.members.map((mem) => ({
      ...mem,
      axis: mem.axis ? { start: apply(R, mem.axis.start), end: apply(R, mem.axis.end) } : mem.axis,
      sectionFrame: mem.sectionFrame
        ? { vy: apply(R, mem.sectionFrame.vy), vz: apply(R, mem.sectionFrame.vz) }
        : mem.sectionFrame,
    })),
    plates: m.plates.map((p) => ({ ...p, lcs: rotLcs(R, p.lcs) })),
    boltGrids: m.boltGrids.map((g) => ({
      ...g, lcs: rotLcs(R, g.lcs), positions: g.positions.map((pos) => apply(R, pos)),
    })),
    welds: m.welds.map((w) => ({ ...w, start: apply(R, w.start), end: apply(R, w.end) })),
  };
}
