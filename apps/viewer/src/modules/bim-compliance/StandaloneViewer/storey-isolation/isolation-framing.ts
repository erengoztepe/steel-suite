import type { Components } from "@thatopen/components";
import { FragmentsManager } from "@thatopen/components";
import * as THREE from "three";

import { jacobiEigenSym3 } from "@/modules/bim-compliance/member-vectors/joint-solver";

/**
 * Where the camera frames an isolated selection (the user's spec):
 *
 *  - It looks at the JOINT: the point closest to every member's axis line —
 *    the same least-squares CPA `solveJoint` computes. The solver only runs on
 *    extraction output, and extraction starts only once the camera has landed,
 *    so the axes come from the members' own mesh vertices here: each member's
 *    principal direction, through its centroid. A single member has no joint;
 *    the camera looks at its box centre.
 *  - It sizes itself on the SMALLEST box around every member except the longest
 *    — the chord or column running through the joint would otherwise set the
 *    scale. From two members up; a single member is its own box.
 *  - Default distance (before any push-in) = (shortest + longest box edge) / 2.
 */

export interface IsolationFraming {
  target: THREE.Vector3;
  /** Camera-to-target distance before any push-in. */
  distance: number;
}

interface MemberShape {
  points: THREE.Vector3[];
  centroid: THREE.Vector3;
  /** Principal direction of the vertices, unit length. */
  axis: THREE.Vector3;
  /** Extent along `axis`. */
  length: number;
}

interface FramedBox {
  center: THREE.Vector3;
  edges: [number, number, number];
  volume: number;
}

/** Floor for a point-like selection (scene units, m) — the floor the old box fit had. */
const MIN_DISTANCE = 0.5;

/**
 * How far outside the members a joint estimate may land before it is not
 * trusted (fraction of their overall box diagonal). Skew members that never
 * actually meet have a CPA somewhere in space; the box centre is the saner
 * target then.
 */
const JOINT_REACH = 0.25;

const WORLD_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

export async function frameIsolatedMembers(
  components: Components,
  visibleByModel: Record<string, Set<number>>,
): Promise<IsolationFraming | null> {
  const shapes = await memberShapes(components, visibleByModel);
  if (shapes.length === 0) return null;

  const longest = shapes.reduce((a, b) => (b.length > a.length ? b : a));
  const boxMembers = shapes.length >= 2 ? shapes.filter((s) => s !== longest) : shapes;
  const box = smallestBox(
    boxMembers.flatMap((s) => s.points),
    boxMembers.map((s) => s.axis),
  );
  const shortest = Math.min(...box.edges);
  const longestEdge = Math.max(...box.edges);
  const distance = Math.max((shortest + longestEdge) / 2, MIN_DISTANCE);

  let target = box.center;
  if (shapes.length >= 2) {
    const joint = estimateJoint(shapes);
    if (joint && withinReach(joint, shapes)) target = joint;
  }
  return { target, distance };
}

/**
 * Every member's vertices in scene (world) coordinates, reduced to a shape.
 * The chain mirrors `getMergedBox`: mesh transform, then the model object's
 * world matrix. Worker-cloned, `transform` arrives as a plain `{ elements }`
 * object rather than a Matrix4.
 */
async function memberShapes(components: Components, visibleByModel: Record<string, Set<number>>): Promise<MemberShape[]> {
  const fragments = components.get(FragmentsManager);
  const shapes: MemberShape[] = [];
  for (const [modelId, localIds] of Object.entries(visibleByModel)) {
    const model = fragments.list.get(modelId);
    if (!model || localIds.size === 0) continue;
    const perItem = await model.getItemsGeometry([...localIds]);
    const toWorld = model.object.matrixWorld;
    for (const meshes of perItem) {
      const points: THREE.Vector3[] = [];
      for (const mesh of meshes ?? []) {
        const positions = mesh.positions;
        if (!positions) continue;
        const elements = (mesh.transform as unknown as { elements: number[] }).elements;
        const toScene = new THREE.Matrix4().fromArray(elements).premultiply(toWorld);
        for (let k = 0; k + 2 < positions.length; k += 3) {
          points.push(new THREE.Vector3(positions[k], positions[k + 1], positions[k + 2]).applyMatrix4(toScene));
        }
      }
      const shape = shapeOf(points);
      if (shape) shapes.push(shape);
    }
  }
  return shapes;
}

function centroidOf(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  return c.divideScalar(points.length);
}

/** Principal axes of the points (unit vectors, largest spread first). */
function principalAxes(points: THREE.Vector3[], centroid: THREE.Vector3): THREE.Vector3[] {
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dz = p.z - centroid.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const { values, vectors } = jacobiEigenSym3([xx, xy, xz, xy, yy, yz, xz, yz, zz]);
  return [0, 1, 2]
    .sort((a, b) => values[b] - values[a])
    .map((j) => new THREE.Vector3(vectors[j], vectors[3 + j], vectors[6 + j]).normalize());
}

function shapeOf(points: THREE.Vector3[]): MemberShape | null {
  if (points.length === 0) return null;
  const centroid = centroidOf(points);
  const [axis] = principalAxes(points, centroid);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = p.dot(axis);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { points, centroid, axis, length: hi - lo };
}

/** The box around `points` with its edges along the orthonormal `axes`. */
function boxAlong(points: THREE.Vector3[], axes: THREE.Vector3[]): FramedBox {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      const d = p.dot(axes[i]);
      if (d < min[i]) min[i] = d;
      if (d > max[i]) max[i] = d;
    }
  }
  const edges: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center = new THREE.Vector3();
  for (let i = 0; i < 3; i++) center.addScaledVector(axes[i], (min[i] + max[i]) / 2);
  return { center, edges, volume: edges[0] * edges[1] * edges[2] };
}

/**
 * The smallest box it can find around `points`. The exact minimum-volume box is
 * costly in 3D, so this tries the orientations that matter for steel members
 * and keeps the smallest: the world axes (never worse than the old box), the
 * points' principal axes, and — around each member axis and principal axis —
 * the minimum-area rectangle of the points seen along that axis, which is exact
 * for that axis. Ties (flat selections) go to the smaller edge sum.
 */
function smallestBox(points: THREE.Vector3[], memberAxes: THREE.Vector3[]): FramedBox {
  const principal = principalAxes(points, centroidOf(points));
  const frames: THREE.Vector3[][] = [WORLD_AXES, principal];
  for (const axis of [...memberAxes, ...principal]) frames.push(minAreaFrameAround(points, axis));

  let best: FramedBox | null = null;
  for (const frame of frames) {
    const box = boxAlong(points, frame);
    if (!best || isSmaller(box, best)) best = box;
  }
  return best!;
}

function isSmaller(a: FramedBox, b: FramedBox): boolean {
  const scale = Math.max(a.volume, b.volume, 1e-12);
  if (Math.abs(a.volume - b.volume) > scale * 1e-9) return a.volume < b.volume;
  return a.edges[0] + a.edges[1] + a.edges[2] < b.edges[0] + b.edges[1] + b.edges[2];
}

/**
 * Orthonormal frame with `axis` as one edge direction and the other two along
 * the minimum-area rectangle of the points projected onto the plane ⟂ `axis`
 * (rotating calipers: that rectangle always has a side on a hull edge).
 */
function minAreaFrameAround(points: THREE.Vector3[], axis: THREE.Vector3): THREE.Vector3[] {
  const a = axis.clone().normalize();
  const helper = Math.abs(a.x) < 0.9 ? WORLD_AXES[0] : WORLD_AXES[1];
  const e1 = new THREE.Vector3().crossVectors(a, helper).normalize();
  const e2 = new THREE.Vector3().crossVectors(a, e1).normalize();
  const hull = convexHull2D(points.map((p) => [p.dot(e1), p.dot(e2)] as [number, number]));

  let bestArea = Infinity;
  let bestCos = 1;
  let bestSin = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    const c = (x1 - x0) / len;
    const s = (y1 - y0) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      bestCos = c;
      bestSin = s;
    }
  }
  const u = e1.clone().multiplyScalar(bestCos).addScaledVector(e2, bestSin);
  const v = e1.clone().multiplyScalar(-bestSin).addScaledVector(e2, bestCos);
  return [a, u, v];
}

/** Andrew's monotone chain; counter-clockwise, no repeated end point. */
function convexHull2D(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Point closest to every member axis line: Σ(I − ddᵀ)·P = Σ(I − ddᵀ)·c, as in
 * `solveJoint`. Where the lines leave a direction free (parallel or collinear
 * members) the solver's pseudo-inverse picks the point nearest the world ORIGIN
 * — fine for its offsets, useless as a camera target — so a tiny pull toward
 * the members' mean centroid decides that direction instead; it is far too weak
 * to move a joint the lines actually pin down.
 */
function estimateJoint(shapes: MemberShape[]): THREE.Vector3 | null {
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const B = new THREE.Vector3();
  const mean = new THREE.Vector3();
  for (const { axis: d, centroid: c } of shapes) {
    const M = new THREE.Matrix3().set(
      1 - d.x * d.x, -d.x * d.y, -d.x * d.z,
      -d.y * d.x, 1 - d.y * d.y, -d.y * d.z,
      -d.z * d.x, -d.z * d.y, 1 - d.z * d.z,
    );
    for (let i = 0; i < 9; i++) A.elements[i] += M.elements[i];
    B.add(c.clone().applyMatrix3(M));
    mean.add(c);
  }
  mean.divideScalar(shapes.length);
  const lambda = 1e-6 * ((A.elements[0] + A.elements[4] + A.elements[8]) / 3);
  A.elements[0] += lambda;
  A.elements[4] += lambda;
  A.elements[8] += lambda;
  B.addScaledVector(mean, lambda);
  if (A.determinant() === 0) return null;
  return B.applyMatrix3(A.clone().invert());
}

function withinReach(point: THREE.Vector3, shapes: MemberShape[]): boolean {
  const box = new THREE.Box3();
  for (const s of shapes) for (const p of s.points) box.expandByPoint(p);
  const reach = box.getSize(new THREE.Vector3()).length() * JOINT_REACH;
  return box.expandByScalar(reach).containsPoint(point);
}
