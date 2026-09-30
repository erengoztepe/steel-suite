/**
 * Clipping planes in the viewer, built on ThatOpen's `Clipper`.
 *
 * A clipping plane hides everything on one side of it. This is a GENERAL view
 * operation, kept separate from the ground grid (a passive datum). All clipping
 * lives under one "Clipping" toolbar menu.
 *
 * SIX BUTTONS — two per axis pair (a 2x3 grid: rows = side "a"/"b", columns
 * XY/XZ/YZ). Each button is a plain ON/OFF toggle for ONE plane (no flip, no
 * Ctrl). Per axis the two sides cut OPPOSITE halves, so together they bracket a
 * slab:
 *   - side "a" clips the + side (keeps the - side); starts just past the model
 *     box's + face along the axis;
 *   - side "b" clips the - side (keeps the + side); starts past the - face.
 * Both therefore start CLEAR of the model: switching a plane on clips nothing by
 * itself, and the user pulls the arrow inward to cut (see `pointFor`).
 *
 * ARROW STAND-OFF: the drag arrow does NOT sit on its cut. It is pushed back into
 * the half-space its own plane has already cut away — guaranteed empty — with its
 * TIP stopping TIP_GAP (1 m) short of the cut, and a square OUTLINE lying in the
 * plane marks where the cut actually is. So the arrow never stands inside the
 * geometry it hides, and the two arrows of one axis sit on opposite OUTER sides
 * and can never overlap. That leaves the pair clamp with one job: keep the two
 * CUT PLANES at least MIN_GAP (1 m) apart — no room for arrows needed. WITHIN
 * the plane, the arrow is anchored over the model centre (`anchorOnPlane`).
 *
 * Axis -> world normal accounts for the Y-up viewer vs the Z-up gizmo/IFC frame
 * (import maps ifc(x,y,z) -> world(x,z,-y)); the user names planes by the gizmo:
 *   XY (plan) -> world Y,   XZ -> world Z,   YZ -> world X.
 *
 * Colours: side "a" = the axis colour (X=red/Y=green/Z=blue by the plane's
 * normal), side "b" = its COMPLEMENT: XY blue/yellow, XZ green/magenta, YZ
 * red/cyan. Complements make the two planes of one axis maximally distinct. The
 * 3-point plane is ORANGE — see THREE_POINT_COLOR.
 *
 * HOW THE CLIP REACHES THE GEOMETRY: a `SimplePlane` registers its THREE.Plane
 * on `renderer.three.clippingPlanes` (global three.js clipping) — applied to
 * every draw call including the streamed fragment tiles, and including the gizmo
 * itself, which is why the stand-off above needs `ignoreClipping`.
 */

import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import {
  Clipper,
  Components,
  FragmentsManager,
  OrthoPerspectiveCamera,
  SimpleScene,
  SimpleWorld,
} from "@thatopen/components";
import { Highlighter, Marker, type PostproductionRenderer } from "@thatopen/components-front";
import { SnappingClass } from "@thatopen/fragments";
import * as THREE from "three";

import { computeModelsBox } from "./frame-to-fit";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

export type ClipAxis = "XY" | "XZ" | "YZ";
export type ClipSide = "a" | "b";

/** Which side(s) of each axis are on (for the button icons + menu highlight). */
export type ClipState = {
  XY: { a: boolean; b: boolean };
  XZ: { a: boolean; b: boolean };
  YZ: { a: boolean; b: boolean };
  threePoint: boolean;
  hasAny: boolean;
};

/** Our planes carry this `type` so `deleteAll` only ever removes ours. */
const PLANE_TYPE = "steel-suite-user";

// A pointer-up counts as a pick only if it barely moved from its press.
const CLICK_MOVE_PX = 4;

// Minimum gap (world units ~= metres, per the Measure tool's convention) the two
// CUT PLANES of one axis must keep between them — they never touch or cross.
const MIN_GAP = 1;

// How far outside the model a plane starts, as a fraction of that axis's model
// size (see `pointFor`). Big enough to clear the outermost face, small enough
// that the arrow shows up next to the model rather than adrift beside it.
const START_MARGIN_FRAC = 0.02;

// Gap the arrow TIP keeps behind its own cut, in the same world units. Fixed in
// WORLD space (not screen space) on purpose: the cut must not move when you zoom.
const TIP_GAP = 1;

const ARROW_OPACITY = 0.8;

// Where the translate arrow's tip sits, in handle scales: the cone's BASE is at
// 0.5 along the axis (`arrowGeometry.translate(0, 0.05, 0)` shifts it off centre)
// and it is 0.1 long, so its apex is at 0.6 — measured back out of the live
// gizmo, not read off the constructor.
const ARROW_TIP_SCALES = 0.6;

// THE CUT-PLANE INDICATOR RECTANGLE SETS THE SCALE for everything the gizmo draws.
//
// Its long edge is a fifth of the model box's DIAGONAL — one number for the whole
// model rather than a per-axis one, so all six planes draw the same size marker —
// and its short edge is 0.6 of that. Only in the CONSTANT-size regime, though: the
// gizmo is screen-constant by nature, and this size is the CAP on that. Zoom out
// and the rectangle holds this world size (shrinking on screen); zoom far enough
// IN and it goes back to screen-constant, i.e. it starts shrinking in world terms.
const OUTLINE_LONG_DIAG_FRAC = 1 / 5;
const OUTLINE_ASPECT = 0.6;
const OUTLINE_OPACITY = 0.55;

// The rectangle's long edge measured in gizmo handle scales — the one knob tying
// the ARROW to the rectangle. The cap on the handle scale is derived from it
// (`decoratePlane`), so the arrow (ARROW_TIP_SCALES long) always comes out at half
// the rectangle's long edge, at every zoom, for any model.
const OUTLINE_LONG_SCALES = 1.2;

// The normal-axis guide line: faint while the plane just sits there, brighter
// under the cursor. It lives as long as the plane does, so switching the plane
// off takes it away with everything else.
const AXIS_LINE_IDLE_OPACITY = 0.18;
const AXIS_LINE_HOVER_OPACITY = 0.4;

// Guide half-length, in model extents. `frameToFit` caps the camera at 8 extents,
// so 50 runs off-screen at every zoom the user can reach — "infinite" in practice,
// without putting a 1e6 object in the scene the way TransformControls does.
const AXIS_LINE_SPAN_EXT = 50;

/** Each button's plane normal in the Y-up VIEWER world (see file header). */
const AXIS_VEC: Record<ClipAxis, [number, number, number]> = {
  XY: [0, 1, 0],
  XZ: [0, 0, 1],
  YZ: [1, 0, 0],
};

/** World-position component the plane slides along, per axis. */
const AXIS_COMP: Record<ClipAxis, "x" | "y" | "z"> = { XY: "y", XZ: "z", YZ: "x" };

const AXIS_LIST: ClipAxis[] = ["XY", "XZ", "YZ"];

/** side "a" = axis colour (X=red/Y=green/Z=blue), side "b" = its complement (CMY). */
export const PLANE_COLOR: Record<ClipAxis, Record<ClipSide, string>> = {
  XY: { a: "#0000ff", b: "#ffff00" }, // Z: blue / yellow
  XZ: { a: "#00ff00", b: "#ff00ff" }, // Y: green / magenta
  YZ: { a: "#ff0000", b: "#00ffff" }, // X: red / cyan
};

const emptyState = (): ClipState => ({
  XY: { a: false, b: false },
  XZ: { a: false, b: false },
  YZ: { a: false, b: false },
  threePoint: false,
  hasAny: false,
});

/**
 * The 3-point plane's colour — ONE fixed colour, never an axis colour.
 *
 * It used to be picked from the normal's dominant world axis, which handed the
 * plane red, green or blue: three different colours for one tool, each of them
 * already the colour of a side-"a" axis plane. A user-defined plane is a
 * different KIND of thing from the six, so it gets its own colour.
 *
 * Orange because the six planes are the saturated hue-circle corners at 60°
 * steps (0/60/120/180/240/300), so 30° is the furthest any pure hue can sit from
 * all of them — and of the five 30° slots, orange is the only one with an
 * everyday colour name the six don't already cover (they take red, yellow, green,
 * cyan, blue, magenta; azure/violet/rose would each read as a shade of a plane
 * that already exists). It is also bright, which this toolkit needs: the guide
 * line draws at AXIS_LINE_IDLE_OPACITY and a low-luminance hue (violet, say)
 * would vanish at 18%, and there is headroom left to brighten on hover.
 */
const THREE_POINT_COLOR = "#ff8800";

/**
 * Exempt a material from the GLOBAL clipping planes.
 *
 * `renderer.three.clippingPlanes` clips every material drawn, gizmos included —
 * and the drag arrow now stands on the CUT-AWAY side of its own plane, so without
 * this it would be discarded along with the geometry it is meant to control.
 * three.js offers no per-material opt-out for global planes, so drop the discard
 * chunk from the compiled fragment shader (its uniforms stay, unused).
 * `customProgramCacheKey` keeps this variant from sharing a cached program with
 * an otherwise identical clipping material.
 */
function ignoreClipping(material: THREE.Material & { __noClip?: boolean }): void {
  if (material.__noClip) return;
  material.__noClip = true;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <clipping_planes_fragment>", "");
  };
  material.customProgramCacheKey = () => "steel-suite-no-clip";
  material.needsUpdate = true;
}

/**
 * The cut-plane indicator: an unfilled rectangle lying IN the plane, centred on
 * the arrow's axis. With the arrow standing TIP_GAP short of the cut, this outline
 * is the only thing that says where the cut actually is. Drawn over the model (an
 * annotation, never buried in the geometry it marks) and scaled per frame in
 * `patchGizmo`.
 *
 * Built one unit long, with the OUTLINE_ASPECT short edge baked in, so the
 * per-frame code stays a single uniform scale. `longAlongLocalX` puts the long
 * edge on whichever in-plane axis the model itself runs longer along, so the
 * marker reads as a piece of the plane rather than an arbitrary rectangle.
 */
function newOutline(hex: string, longAlongLocalX: boolean): THREE.LineLoop {
  const half = 0.5;
  const [hx, hy] = longAlongLocalX ? [half, half * OUTLINE_ASPECT] : [half * OUTLINE_ASPECT, half];
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx, -hy, 0),
    new THREE.Vector3(hx, -hy, 0),
    new THREE.Vector3(hx, hy, 0),
    new THREE.Vector3(-hx, hy, 0),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(hex),
    transparent: true,
    opacity: OUTLINE_OPACITY,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  ignoreClipping(material);
  const outline = new THREE.LineLoop(geometry, material);
  outline.renderOrder = Infinity;
  return outline;
}

/**
 * The normal-axis guide: one long line through the plane origin along its normal,
 * showing which way the plane will travel when dragged.
 *
 * Our own line rather than TransformControls' `AXIS` helper, which three.js shows
 * ONLY while a handle is hovered or dragged and re-derives its orientation from
 * `this.axis` each frame — so making it persist would mean re-deriving that
 * orientation ourselves every frame. As a child of the plane helper (whose local
 * Z IS the normal) this needs no orientation maths at all, and its opacity is
 * ours to set per frame. `patchGizmo` hides the built-in one so they don't stack.
 */
function newAxisLine(hex: string, span: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, -span),
    new THREE.Vector3(0, 0, span),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(hex),
    transparent: true,
    opacity: AXIS_LINE_IDLE_OPACITY,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  ignoreClipping(material);
  const line = new THREE.Line(geometry, material);
  line.renderOrder = Infinity;
  return line;
}

/**
 * Recolour a SimplePlane's TransformControls drag arrow. The gizmo caches each
 * material's base colour lazily on its first update, so setting `color` before
 * that (right after creation) makes it stick; we also overwrite `_color`
 * defensively in case it already exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function colorGizmo(plane: any, hex: string): void {
  const helper = plane?._controls?.getHelper?.();
  if (!helper) return;
  const col = new THREE.Color(hex);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  helper.traverse((o: any) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.color) m.color.copy(col);
      if (m._color?.copy) m._color.copy(col);
      // All arrows at 80% opacity (the gizmo restores from `_opacity` each frame).
      m.transparent = true;
      m.opacity = ARROW_OPACITY;
      m._opacity = ARROW_OPACITY;
      // The arrow lives in the cut-away half now — don't let the clip eat it.
      ignoreClipping(m);
    }
  });
}

const HIGHLIGHT_WHITE = new THREE.Color(0xffffff);

/**
 * TransformControls' own infinite axis lines, by handle name: "X"/"Y"/"Z" in
 * translate mode, "AXIS" in rotate/scale. NOT the other helper-tagged handles
 * (START/END/DELTA) — those are the drag markers and stay.
 */
const AXIS_HELPER_NAMES = new Set(["AXIS", "X", "Y", "Z"]);

/**
 * True for the translate arrow's OUTWARD head. The gizmo's arrow is double-headed
 * (cones baked into the geometry at ±0.5 along the axis); the head on the far
 * side of the normal is hidden so one head remains, pointing AT the cut plane.
 * Until now the outward head simply fell on the cut-away side and was clipped
 * out of existence — which is exactly why the cut looked like it sat at the
 * arrow's tail.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isOutwardHead(handle: any): boolean {
  const geom = handle?.geometry;
  if (!geom) return false;
  if (!geom.boundingBox) geom.computeBoundingBox();
  return !!geom.boundingBox && geom.boundingBox.max.z < -0.1;
}

/**
 * Wrap the gizmo's `updateMatrixWorld` (which runs every frame) to fix four
 * TransformControls behaviours:
 *   1. Scale: the gizmo scales each handle by camera distance to stay a constant
 *      SCREEN size, so its WORLD volume balloons over the model when zoomed out.
 *      We cap the per-handle scale at `maxScale` — normal (screen-constant) up
 *      close, but it stops growing when far, so it never covers the model.
 *   2. Stand-off: push the whole gizmo back along -normal until the arrow tip
 *      stops TIP_GAP short of the cut (see the file header). The push runs along
 *      the drag axis, which lies IN the TransformControls drag plane, so the
 *      drag still tracks the cursor 1:1.
 *   3. Hide the outward arrow head and the built-in `AXIS` helper line, size the
 *      cut-plane outline in step with the (capped) handle scale, and fade the
 *      normal-axis guide by whether a handle is hovered.
 *   4. Highlight: the default hover highlight is yellow (`setHex(0xffff00)`); we
 *      re-tint the hovered handle to a brighter shade of its OWN colour instead
 *      (blend its stored base `material._color` toward white).
 *
 * (1)-(3) edit handle transforms AFTER the original ran, and the original ends by
 * baking matrices from ITS values (then overwrites position/scale from scratch
 * next frame) — so we re-run the matrix pass over our own values, otherwise the
 * edits never reach a draw call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchGizmo(plane: any, maxScale: number, outline: THREE.Object3D, axisLine: THREE.Line): void {
  const helper = plane?._controls?.getHelper?.();
  if (!helper) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gizmo: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  helper.traverse((o: any) => {
    if (o?.constructor?.name === "TransformControlsGizmo") gizmo = o;
  });
  if (!gizmo) return;
  gizmo.__maxScale = maxScale; // refresh even if already patched (model may have changed)
  gizmo.__outline = outline;
  gizmo.__axisLine = axisLine;
  if (gizmo.__patched) return;
  gizmo.__patched = true;
  const orig = gizmo.updateMatrixWorld.bind(gizmo);
  const tmp = new THREE.Color();
  const normal = new THREE.Vector3();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gizmo.updateMatrixWorld = function (this: any, force?: boolean) {
    orig(force);
    const cap = this.__maxScale as number;
    const mode = this.mode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups: any[] = mode
      ? [this.picker?.[mode], this.gizmo?.[mode], this.helper?.[mode]].filter(Boolean)
      : [];
    if (groups.length) {
      // (1) cap the world scale
      let scale = 0;
      for (const group of groups) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const h of group.children as any[]) {
          if (cap && h.scale.x > cap) h.scale.setScalar(cap);
          scale = Math.max(scale, h.scale.x);
        }
      }
      // (2) stand the gizmo off its plane, tip TIP_GAP short of the cut. Local +Z
      // is the plane normal (the helper was built with `lookAt(normal)`), and the
      // controls run in "local" space, so the handles' quaternion carries it.
      normal.set(0, 0, 1).applyQuaternion(this.worldQuaternion);
      const standOff = scale * ARROW_TIP_SCALES + TIP_GAP;
      for (const group of groups) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const h of group.children as any[]) h.position.addScaledVector(normal, -standOff);
      }
      // (3) one head only, pointing at the plane
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const h of (this.gizmo?.[mode]?.children ?? []) as any[]) {
        if (h.__outward === undefined) h.__outward = isOutwardHead(h);
        if (h.__outward) h.visible = false;
      }
      // Built-in axis lines off — `newAxisLine` draws that guide instead, and two
      // lines on the same axis would just add their opacities. three.js shows
      // these only while a handle is hovered or dragged, so leaving them on would
      // also mean the guide jumped to full strength exactly on hover.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const h of (this.helper?.[mode]?.children ?? []) as any[]) {
        if (AXIS_HELPER_NAMES.has(h.name)) h.visible = false;
      }
      THREE.Object3D.prototype.updateMatrixWorld.call(this, true);
      const mark = this.__outline as THREE.Object3D | undefined;
      if (mark && scale > 0) {
        mark.scale.setScalar(scale * OUTLINE_LONG_SCALES);
        // Its parent (the plane helper) sits earlier in the scene graph and is
        // already up to date this frame, so this lands in the SAME frame.
        mark.updateMatrixWorld(true);
      }
    }
    // The guide only brightens under the cursor; it is drawn for as long as the
    // plane exists, so there is nothing to switch off when the cursor leaves.
    const guide = this.__axisLine as THREE.Line | undefined;
    if (guide) {
      (guide.material as THREE.LineBasicMaterial).opacity = this.axis
        ? AXIS_LINE_HOVER_OPACITY
        : AXIS_LINE_IDLE_OPACITY;
    }
    // (4) brighter-own-colour hover highlight
    const axis: string | null = this.axis;
    if (!axis) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.traverse((h: any) => {
      const m = h.material;
      if (!m || !m._color) return;
      if (h.name !== axis && !axis.split("").includes(h.name)) return;
      m.color.copy(tmp.copy(m._color).lerp(HIGHLIGHT_WHITE, 0.35));
      m.opacity = ARROW_OPACITY;
    });
  };
}

/**
 * Post-create tweaks: tag the plane so clear only touches ours, hide its
 * translucent representation square (it tinted the whole view purple), add the
 * outline that marks the cut and the guide line along the normal, colour the drag
 * arrow (at 80% opacity), stand it off the cut, cap its zoom scale, and make its
 * hover highlight a brighter shade of that colour.
 *
 * Takes the model box SIZE, not a scale: everything drawn here is measured off it
 * (rectangle from the diagonal, arrow from the rectangle, guide from the extent),
 * so one model measurement drives the whole gizmo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decoratePlane(plane: any, colorHex: string, size: THREE.Vector3): void {
  if (!plane) return;
  plane.type = PLANE_TYPE;
  if (plane._planeMesh) plane._planeMesh.visible = false;

  const extent = Math.max(size.x, size.y, size.z, 1);
  const longEdge = Math.max(size.length() * OUTLINE_LONG_DIAG_FRAC, 1e-3);
  // Which in-plane axis does the model run longer along? The plane helper's local
  // Z is the normal, so its local X and Y span the cut plane; the extent of an
  // axis-aligned box along a unit direction is |size . |dir||.
  const spanAlong = (localAxis: THREE.Vector3): number => {
    const v = localAxis.applyQuaternion(plane._helper.quaternion);
    return Math.abs(size.x * v.x) + Math.abs(size.y * v.y) + Math.abs(size.z * v.z);
  };
  const longAlongLocalX = spanAlong(new THREE.Vector3(1, 0, 0)) >= spanAlong(new THREE.Vector3(0, 1, 0));

  const outline = newOutline(colorHex, longAlongLocalX);
  const axisLine = newAxisLine(colorHex, extent * AXIS_LINE_SPAN_EXT);
  // Children of the helper, so they ride every drag with zero bookkeeping — the
  // helper IS the plane origin, its local XY plane IS the cut plane, and its
  // local Z IS the normal.
  plane._helper?.add(outline);
  plane._helper?.add(axisLine);
  plane.onDisposed?.add?.(() => {
    for (const o of [outline, axisLine]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  colorGizmo(plane, colorHex);
  // The scale cap works backwards from the rectangle: a handle scale of
  // `longEdge / OUTLINE_LONG_SCALES` is exactly the one that draws the rectangle
  // at its specified long edge, so capping there sizes the arrow to match.
  patchGizmo(plane, longEdge / OUTLINE_LONG_SCALES, outline, axisLine);
}

export interface ClipToolApi {
  /** Toggle one plane on/off (plain click — no flip, no modifiers). */
  toggle: (axis: ClipAxis, side: ClipSide) => void;
  /** Remove any 3-point plane(s) — the 3-Point button's off gesture. */
  clearThreePoint: () => void;
}

export function useClipTool(
  components: Components,
  worldRef: MutableRefObject<World | null> | undefined,
  threePointActive: boolean,
  onStateChange?: (state: ClipState) => void,
  onThreePointDone?: () => void,
): ClipToolApi {
  // plane id per `${axis}:${side}` (absent = that plane is off).
  const planeIdsRef = useRef<Record<string, string>>({});
  const threePointIdsRef = useRef<string[]>([]);
  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  const onDoneRef = useRef(onThreePointDone);
  onDoneRef.current = onThreePointDone;

  const seed = useCallback(() => {
    const box = computeModelsBox(components);
    if (box.isEmpty()) {
      return { center: new THREE.Vector3(), size: new THREE.Vector3(10, 10, 10), ext: 10 };
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    return { center, size, ext: Math.max(size.x, size.y, size.z, 1) };
  }, [components]);

  const report = useCallback(() => {
    const st = emptyState();
    const threePoint = threePointIdsRef.current.length > 0;
    let hasAny = threePoint;
    for (const axis of AXIS_LIST) {
      const a = !!planeIdsRef.current[`${axis}:a`];
      const b = !!planeIdsRef.current[`${axis}:b`];
      st[axis] = { a, b };
      if (a || b) hasAny = true;
    }
    st.threePoint = threePoint;
    st.hasAny = hasAny;
    onStateRef.current?.(st);
  }, []);

  // side "a" clips the + side (normal -axis, keeps <= pos); side "b" clips the -
  // side (normal +axis, keeps >= pos).
  const normalFor = (axis: ClipAxis, side: ClipSide): THREE.Vector3 => {
    const v = new THREE.Vector3(...AXIS_VEC[axis]);
    return (side === "a" ? v.negate() : v).normalize();
  };

  // Each plane starts just CLEAR OF THE MODEL on its own side: "a" past the box's
  // + face, "b" past its - face. So switching a plane on never hides anything by
  // itself — the arrow appears outside the model and the user pulls it in.
  //
  // Measured from the model box, NOT the world origin. The old |axis extent|/3
  // from the origin made "starts inside" vs "starts outside" depend entirely on
  // where the IFC's own origin happened to sit: on the bundled roof five of the
  // six planes cut geometry the moment they were switched on, and which five
  // changes from file to file.
  const pointFor = (
    axis: ClipAxis,
    side: ClipSide,
    center: THREE.Vector3,
    size: THREE.Vector3,
  ): THREE.Vector3 => {
    const comp = AXIS_COMP[axis];
    const axisSize = size[comp];
    // The floor keeps a flat (degenerate) box from starting exactly coincident
    // with the model's own face, where the clip test is a coin toss.
    const margin = Math.max(axisSize * START_MARGIN_FRAC, 1e-3);
    const half = axisSize / 2 + margin;
    const off = center[comp] + (side === "a" ? half : -half);
    return new THREE.Vector3(...AXIS_VEC[axis]).multiplyScalar(off);
  };

  // WHERE THE GIZMO SITS on its plane. A clipping plane is infinite, so sliding
  // its origin WITHIN the plane changes nothing about what gets cut — it only
  // decides where the drag arrow and the outline show up. Anchoring that to the
  // model centre projected onto the plane puts them in the middle of whatever is
  // loaded, instead of over the file's own origin (which can sit anywhere, often
  // off the side of the model). Same rule for the 3-point plane, so the arrow
  // doesn't strand itself on the first point the user happened to pick.
  const anchorOnPlane = useCallback(
    (normal: THREE.Vector3, coplanar: THREE.Vector3, center: THREE.Vector3): THREE.Vector3 =>
      new THREE.Plane()
        .setFromNormalAndCoplanarPoint(normal, coplanar)
        .projectPoint(center, new THREE.Vector3()),
    [],
  );

  // Keep the two planes of one axis from crossing: "a" must stay on the + side
  // of "b" along the axis, MIN_GAP clear of it. Called on every drag of either
  // plane; clamps whichever one is being dragged back off the sibling.
  const clampAgainstSibling = useCallback(
    (axis: ClipAxis, side: ClipSide) => {
      const clipper = components.get(Clipper);
      const aid = planeIdsRef.current[`${axis}:a`];
      const bid = planeIdsRef.current[`${axis}:b`];
      if (!aid || !bid) return; // both must exist to constrain
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pa = clipper.list.get(aid) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pb = clipper.list.get(bid) as any;
      if (!pa?._helper || !pb?._helper) return;
      const comp = AXIS_COMP[axis];
      // Only the CUT PLANES need a floor: each arrow stands off on the outer,
      // cut-away side of its own plane, so the pair cannot collide however thin
      // the remaining slab gets.
      if (pa._helper.position[comp] - pb._helper.position[comp] >= MIN_GAP) return;
      if (side === "a") pa._helper.position[comp] = pb._helper.position[comp] + MIN_GAP;
      else pb._helper.position[comp] = pa._helper.position[comp] - MIN_GAP;
      const moved = side === "a" ? pa : pb;
      moved._helper.updateMatrix();
      moved.update();
      const world = worldRef?.current;
      if (world?.renderer) world.renderer.needsUpdate = true;
    },
    [components, worldRef],
  );

  const toggle = useCallback(
    (axis: ClipAxis, side: ClipSide) => {
      const world = worldRef?.current;
      if (!world) return;
      const clipper = components.get(Clipper);
      const key = `${axis}:${side}`;
      const existing = planeIdsRef.current[key];

      if (existing) {
        clipper.list.delete(existing);
        delete planeIdsRef.current[key];
      } else {
        const { center, size, ext } = seed();
        clipper.size = Math.max(ext * 0.6, 1);
        const normal = normalFor(axis, side);
        const origin = anchorOnPlane(normal, pointFor(axis, side, center, size), center);
        const id = clipper.createFromNormalAndCoplanarPoint(world, normal, origin);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plane = clipper.list.get(id) as any;
        decoratePlane(plane, PLANE_COLOR[axis][side], size);
        // Clamp against the sibling on every drag so the pair can't cross.
        plane?._controls?.addEventListener?.("objectChange", () => clampAgainstSibling(axis, side));
        planeIdsRef.current[key] = id;
      }

      if (world.renderer) world.renderer.needsUpdate = true;
      report();
    },
    [components, worldRef, seed, report, clampAgainstSibling, anchorOnPlane],
  );

  const clearThreePoint = useCallback(() => {
    const world = worldRef?.current;
    const clipper = components.get(Clipper);
    for (const id of threePointIdsRef.current) clipper.list.delete(id);
    threePointIdsRef.current = [];
    if (world?.renderer) world.renderer.needsUpdate = true;
    report();
  }, [components, worldRef, report]);

  // --- 3-point picking mode --------------------------------------------------
  useEffect(() => {
    const world = worldRef?.current;
    if (!threePointActive || !world || !world.renderer) return undefined;

    const fragments = components.get(FragmentsManager);
    const clipper = components.get(Clipper);
    const marker = components.get(Marker);
    const highlighter = components.get(Highlighter);
    const canvas = world.renderer.three.domElement;

    const points: THREE.Vector3[] = [];
    const markerIds: string[] = [];

    const requestRender = () => {
      world.renderer!.needsUpdate = true;
    };
    const clearDots = () => {
      for (const id of markerIds) marker.delete(id);
      markerIds.length = 0;
    };
    const addDot = (at: THREE.Vector3) => {
      const el = document.createElement("div");
      el.style.width = "10px";
      el.style.height = "10px";
      el.style.borderRadius = "50%";
      el.style.border = "2px solid #38bdf8";
      el.style.background = "#38bdf8";
      el.style.boxShadow = "0 0 0 1px rgba(15, 23, 42, 0.9)";
      el.style.transform = "translate(-50%, -50%)";
      el.style.pointerEvents = "none";
      const id = marker.create(world, el, at.clone(), true);
      if (id) markerIds.push(id);
    };

    const hadHighlighter = highlighter.enabled;
    highlighter.enabled = false;

    const pick = async (x: number, y: number): Promise<THREE.Vector3 | null> => {
      try {
        const r = await fragments.raycast({
          camera: world.camera.three,
          dom: canvas,
          mouse: new THREE.Vector2(x, y),
          snappingClasses: [SnappingClass.POINT],
        });
        return r?.point ? r.point.clone() : null;
      } catch {
        return null;
      }
    };

    const finish = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      const normal = new THREE.Vector3()
        .subVectors(b, a)
        .cross(new THREE.Vector3().subVectors(c, a));
      clearDots();
      requestRender();
      if (normal.lengthSq() < 1e-9) {
        onDoneRef.current?.();
        return;
      }
      const { center, size, ext } = seed();
      clipper.size = Math.max(ext * 0.6, 1);
      const nrm = normal.normalize();
      const id = clipper.createFromNormalAndCoplanarPoint(world, nrm, anchorOnPlane(nrm, a, center));
      decoratePlane(clipper.list.get(id), THREE_POINT_COLOR, size);
      threePointIdsRef.current.push(id);
      if (world.renderer) world.renderer.needsUpdate = true;
      report();
      onDoneRef.current?.();
    };

    let downX = 0;
    let downY = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !canvas.contains(e.target)) return;
      if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_MOVE_PX) return; // was a drag
      e.stopImmediatePropagation();
      e.preventDefault();
      void pick(e.clientX, e.clientY).then((p) => {
        if (!p) return;
        points.push(p);
        addDot(p);
        requestRender();
        if (points.length === 3) finish(points[0], points[1], points[2]);
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        points.length = 0;
        clearDots();
        requestRender();
      }
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("keydown", onKey);
      clearDots();
      highlighter.enabled = hadHighlighter;
      requestRender();
    };
  }, [components, worldRef, threePointActive, seed, report, anchorOnPlane]);

  return { toggle, clearThreePoint };
}
