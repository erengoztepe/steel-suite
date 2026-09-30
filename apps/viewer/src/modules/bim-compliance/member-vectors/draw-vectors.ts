/**
 * Draws the joint overlay in the 3D viewer: the connection node plus, for every
 * member, its centerline positioned at the member's REAL location (so any
 * eccentricity/skew is visible in true 3D) and a close→far direction arrow.
 * Members are coloured by role; the bearing member is amber.
 *
 * Everything is drawn from the solver's IFC-space geometry (the connection
 * `node`, each member's `start`/`end`, and a curved member's `curve`), mapped
 * through a single IFC→scene SIMILARITY transform:
 *   scene = scale · R(ifc) + translation
 * where R is the known Z-up→Y-up swap (x,y,z)→(x,z,-y). `scale` and
 * `translation` are recovered empirically from the members' scene bounding
 * boxes: a straight member's axis-aligned box is centred on its centerline
 * midpoint and its diagonal ≈ its length, so each straight member gives one
 * (scale, translation) estimate; we take the median scale and mean translation.
 * This is what lets a CURVED member's arrow sit at the actual joint (which for a
 * continuous member is mid-span, NOT a bounding-box corner) and its centerline
 * follow the real arc — the earlier bounding-box-only placement put the arrow at
 * a box extreme, ~half the arc away from the node.
 */

import { BoundingBoxer, Components, type SimpleWorld } from "@thatopen/components";
import * as THREE from "three";

import { BEARING_COLOR_NUM, memberRole, NODE_COLOR_NUM, ROLE_COLOR_NUM } from "./member-roles";
import type { OrientedMemberVectorRow } from "./types";

const GROUP_NAME = "member-vectors-arrows";

/** Member length (mm) beyond which arrowhead/gap sizing stops growing further. */
const ARROWHEAD_CAP_LENGTH_MM = 8000;

type Vec3 = [number, number, number];

/** IFC Z-up vector → scene Y-up (rotation only, NOT scaled or translated). */
function ifcVecToScene(u: Vec3): THREE.Vector3 {
  return new THREE.Vector3(u[0], u[2], -u[1]);
}

/** Sample points along a curved member's (circular-arc) centerline, in IFC space. */
function sampleCurve(curve: NonNullable<OrientedMemberVectorRow["curve"]>, samples: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = curve.theta1 + ((curve.theta2 - curve.theta1) * i) / samples;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([
      curve.center[0] + curve.radius * (c * curve.xAxis[0] + s * curve.yAxis[0]),
      curve.center[1] + curve.radius * (c * curve.xAxis[1] + s * curve.yAxis[1]),
      curve.center[2] + curve.radius * (c * curve.xAxis[2] + s * curve.yAxis[2]),
    ]);
  }
  return pts;
}

export async function drawMemberVectors(
  components: Components,
  world: SimpleWorld | null,
  rows: OrientedMemberVectorRow[],
  membersByGlobalId: Map<string, { modelId: string; localId: number }>,
  node: Vec3 | null,
  bearingGlobalId: string | null,
): Promise<void> {
  if (!world?.scene?.three) return;
  clearMemberVectors(world);

  const group = new THREE.Group();
  group.name = GROUP_NAME;

  const boundingBoxer = components.get(BoundingBoxer);

  // Per-member scene bounding box (center + diagonal) — used ONLY to recover the
  // IFC→scene transform below, never to position the drawing directly.
  interface Boxed {
    row: OrientedMemberVectorRow;
    center: THREE.Vector3;
    diag: number;
  }
  const boxed: Boxed[] = [];
  for (const row of rows) {
    if (row.length <= 0) continue;
    const ref = membersByGlobalId.get(row.globalId);
    if (!ref) continue;
    try {
      boundingBoxer.list.clear();
      await boundingBoxer.addFromModelIdMap({ [ref.modelId]: new Set([ref.localId]) });
      const box = boundingBoxer.get();
      boundingBoxer.list.clear();
      if (box.isEmpty?.()) continue;
      boxed.push({
        row,
        center: box.getCenter(new THREE.Vector3()),
        diag: box.getSize(new THREE.Vector3()).length(),
      });
    } catch {
      /* ignore */
    }
  }
  if (boxed.length === 0) {
    world.scene.three.add(group);
    return;
  }

  // --- Recover the IFC→scene similarity transform (scale s, translation t) ---
  // A STRAIGHT member's axis-aligned scene box is centred on its centerline
  // midpoint, so boxCenter ↔ R(ifcMidpoint) are exact point correspondences.
  // scale = ratio of scene distances to IFC distances between two such centres
  // (UNBIASED — unlike diag/length, whose box diagonal overshoots the length by
  // the section depth). Curved members' boxes are NOT centred on their
  // centerline, so they only anchor the transform when no straight member
  // exists (fallback).
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const straight = boxed.filter((b) => !b.row.curve);
  const anchors = straight.length > 0 ? straight : boxed;
  const anchorMids = anchors.map((b) => ({
    center: b.center,
    diag: b.diag,
    length: b.row.length,
    mid: ifcVecToScene([
      (b.row.start[0] + b.row.end[0]) / 2,
      (b.row.start[1] + b.row.end[1]) / 2,
      (b.row.start[2] + b.row.end[2]) / 2,
    ]),
  }));
  const ratios: number[] = [];
  for (let i = 0; i < anchorMids.length; i++) {
    for (let j = i + 1; j < anchorMids.length; j++) {
      const dIfc = anchorMids[i].mid.distanceTo(anchorMids[j].mid);
      if (dIfc > 1e-6) ratios.push(anchorMids[i].center.distanceTo(anchorMids[j].center) / dIfc);
    }
  }
  // Fall back to diag/length only with a single anchor (no pair to compare).
  const scale = ratios.length > 0 ? median(ratios) : median(anchors.map((b) => b.diag / b.row.length));
  const translation = new THREE.Vector3();
  for (const a of anchorMids) translation.add(a.center.clone().sub(a.mid.clone().multiplyScalar(scale)));
  translation.multiplyScalar(1 / anchorMids.length);

  /** Map an IFC point into scene space via the recovered similarity transform. */
  const mapPt = (p: Vec3): THREE.Vector3 => ifcVecToScene(p).multiplyScalar(scale).add(translation);
  /** Map an IFC direction into scene space (rotation only, renormalised). */
  const mapDir = (u: Vec3): THREE.Vector3 => ifcVecToScene(u).normalize();

  const maxSceneLen = Math.max(...boxed.map((b) => b.diag));
  const axisLen = maxSceneLen * 1.5; // half-length of the straight "infinite" line
  const connR = maxSceneLen * 0.012; // eccentricity connector tube radius

  const nodeScene = node ? mapPt(node) : null;

  for (const b of boxed) {
    const row = b.row;
    const isB = row.globalId === bearingGlobalId;
    const color = isB ? BEARING_COLOR_NUM : ROLE_COLOR_NUM[memberRole(row.unit)];
    const sceneClose = mapPt(row.start); // solver "close" = joint-side point (on the arc for a curved member)
    const dir = mapDir(row.unit); // oriented direction (near-joint tangent for a curved member)
    if (dir.lengthSq() === 0) continue;
    const sceneLen = row.length * scale;

    if (row.curve) {
      // Curved member: draw the real arc centerline (follows the steel), so the
      // amber bearing line runs down the middle of the curved mesh rather than
      // as a straight chord/tangent floating off it.
      const arcPts = sampleCurve(row.curve, 48).map(mapPt);
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(arcPts),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }),
        ),
      );
    } else {
      // Straight member: faint "infinite" axis line through its real position.
      const a = sceneClose.clone().addScaledVector(dir, -axisLen);
      const bEnd = sceneClose.clone().addScaledVector(dir, axisLen);
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([a, bEnd]),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }),
        ),
      );
    }

    // Solid direction arrow starting at the joint-side point. The arrowhead is
    // pushed past the far end by `gap` so the cone doesn't bury itself in the
    // (much thicker) member mesh. Head/gap sizing caps at an 8 m-equivalent so a
    // 36 m curved chord doesn't grow a comically oversized cone. For a curved
    // member the shaft is capped to a fraction of the span so a straight tangent
    // arrow doesn't visibly diverge from the arc it represents.
    const headSizeBasis = Math.min(sceneLen, ARROWHEAD_CAP_LENGTH_MM * scale);
    const headLen = headSizeBasis * 0.2;
    const gap = headSizeBasis * 0.15;
    const shaftLen = row.curve ? Math.min(sceneLen, ARROWHEAD_CAP_LENGTH_MM * scale) : sceneLen + gap + headLen;
    const arrow = new THREE.ArrowHelper(dir, sceneClose, shaftLen, color, headLen, headLen * 0.5);
    group.add(arrow);

    // Eccentricity connector: perpendicular from the node to this member's
    // near-joint axis line (sceneClose, dir). Its LENGTH is the structural
    // eccentricity (moment arm) — green when negligible, red past the threshold.
    if (nodeScene) {
      const w = nodeScene.clone().sub(sceneClose);
      const foot = sceneClose.clone().addScaledVector(dir, w.dot(dir)); // closest point on axis to node
      const eccScene = nodeScene.distanceTo(foot);
      if (eccScene > connR * 0.5) {
        const conn = new THREE.Mesh(
          new THREE.CylinderGeometry(connR, connR, eccScene, 8),
          new THREE.MeshBasicMaterial({ color: row.eccentricityMm > 25 ? 0xef4444 : 0x35c46a, depthTest: false }),
        );
        conn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(nodeScene).normalize());
        conn.position.copy(nodeScene.clone().add(foot).multiplyScalar(0.5));
        conn.renderOrder = 998;
        group.add(conn);
      }
    }
  }

  // Connection node marker (small, bright, drawn on top) at the solver's node.
  if (nodeScene) {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 20, 20), // fixed 5cm radius (scene units are metres)
      new THREE.MeshBasicMaterial({ color: NODE_COLOR_NUM, depthTest: false }),
    );
    sphere.position.copy(nodeScene);
    sphere.renderOrder = 999;
    group.add(sphere);
  }

  world.scene.three.add(group);
}

const HIDDEN_LINE_FLAG = "__mvHiddenLine";

/**
 * Isolating a fragment item only hides its solid Body mesh — some IFC exports
 * (e.g. Tekla structural analysis curves) render a member's Axis/centerline as a
 * bare THREE.Line/LineSegments outside the FragmentsModel item-visibility system,
 * so it stays visible after isolate. Sweep and hide those directly; the reference
 * grid is a THREE.Mesh (not a line type) so it's unaffected by this filter.
 */
export function hideExtraneousLines(world: SimpleWorld | null): void {
  const scene = world?.scene?.three;
  if (!scene) return;

  const isInsideOwnGroup = (obj: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = obj; p; p = p.parent) {
      if (p.name === GROUP_NAME) return true;
    }
    return false;
  };

  scene.traverse((obj) => {
    if (!obj.visible || isInsideOwnGroup(obj)) return;
    if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
      obj.visible = false;
      obj.userData[HIDDEN_LINE_FLAG] = true;
    }
  });
}

/** Undo {@link hideExtraneousLines}. */
export function restoreExtraneousLines(world: SimpleWorld | null): void {
  const scene = world?.scene?.three;
  if (!scene) return;
  scene.traverse((obj) => {
    if (obj.userData?.[HIDDEN_LINE_FLAG]) {
      obj.visible = true;
      delete obj.userData[HIDDEN_LINE_FLAG];
    }
  });
}

export function clearMemberVectors(world: SimpleWorld | null): void {
  const scene = world?.scene?.three;
  if (!scene) return;
  const existing = scene.getObjectByName(GROUP_NAME);
  if (existing) {
    existing.traverse((obj) => {
      const anyObj = obj as THREE.Mesh & { dispose?: () => void };
      if (anyObj.geometry) anyObj.geometry.dispose?.();
      const mat = (anyObj as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else if (mat) (mat as THREE.Material).dispose?.();
    });
    scene.remove(existing);
  }
}
