/**
 * Point-to-point distance & three-point angle measurement in the viewer.
 *
 * Driven by the control-panel's "Measure" button. Two modes:
 *   - "distance": pick 2 points -> straight segment + its length.
 *   - "angle":    pick 3 points -> the angle at the middle (2nd) point only.
 *                 The two legs are drawn as the angle's rays but carry no
 *                 length labels — reach for distance mode when you want those.
 * Picking a point past the mode's capacity starts a fresh measurement, so the
 * tool stays live for repeated measuring without a separate "reset" click.
 *
 * Each click casts a ray against the loaded fragments. With snapping ENABLED
 * the cast asks for POINT snapping (`raycastWithSnapping`), so the pick lands
 * exactly on the nearest model VERTEX (corner) when the cursor is close to one,
 * and falls back to the plain surface hit otherwise — the library does that
 * fallback itself when no vertex is within snapping range. With snapping OFF
 * the cast is the plain surface hit. The snap toggle is owned by the panel and
 * passed in as `snapEnabled`.
 *
 * Geometry (the connecting segments) lives in a THREE.Group added to the scene,
 * drawn with depthTest off so the measurement is always visible through the
 * model. The picked-point dots, the live cursor/snap indicator and the numeric
 * readouts are HTML labels anchored in 3D via `@thatopen/components-front`'s
 * Marker (CSS2D — same mechanism as the Tag/GUID labels), created `isStatic` so
 * they never merge into cluster bubbles.
 *
 * While active, the Highlighter's selection is disabled (so a measuring click
 * doesn't also select/paint an element) and a capture-phase click swallow keeps
 * the same click from moving the orbit pivot (see use-viewer-navigation). The
 * camera still orbits/pans/zooms normally between picks — only the plain
 * left-click is intercepted, and only when it wasn't a drag.
 */

import { useEffect } from "react";
import type { MutableRefObject } from "react";
import {
  Components,
  FragmentsManager,
  OrthoPerspectiveCamera,
  SimpleScene,
  SimpleWorld,
} from "@thatopen/components";
import { Highlighter, Marker, type PostproductionRenderer } from "@thatopen/components-front";
import { SnappingClass } from "@thatopen/fragments";
import * as THREE from "three";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

export type MeasureMode = "distance" | "angle" | null;

// A pointer-up counts as a "click" (a pick) only if it barely moved from its
// press — anything more is an orbit/pan drag and must not drop a point.
const CLICK_MOVE_PX = 4;

const COMMITTED_COLOR = 0x38bdf8; // sky-400 — matches the viewer's focus accent
const PREVIEW_COLOR = 0xfacc15; // amber-300 — the not-yet-committed cursor leg

/** Metres -> a compact human string, mm under a metre, else metres. */
function formatLength(meters: number): string {
  const mm = meters * 1000;
  if (Math.abs(meters) < 1) return `${mm.toFixed(0)} mm`;
  return `${meters.toFixed(3)} m`;
}

/** Interior angle (deg) at `b`, between rays b->a and b->c. */
function angleAtDeg(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  const ba = new THREE.Vector3().subVectors(a, b);
  const bc = new THREE.Vector3().subVectors(c, b);
  if (ba.lengthSq() === 0 || bc.lengthSq() === 0) return 0;
  return THREE.MathUtils.radToDeg(ba.angleTo(bc));
}

function makeDot(color: number, hollow = false): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "10px";
  el.style.height = "10px";
  el.style.borderRadius = "50%";
  const css = `#${color.toString(16).padStart(6, "0")}`;
  el.style.border = `2px solid ${css}`;
  el.style.background = hollow ? "transparent" : css;
  el.style.boxShadow = "0 0 0 1px rgba(15, 23, 42, 0.9)";
  el.style.transform = "translate(-50%, -50%)";
  el.style.pointerEvents = "none";
  return el;
}

function makeReadout(text: string, accent: number): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.pointerEvents = "none";
  el.style.background = "rgba(15, 23, 42, 0.9)";
  el.style.color = "#e2e8f0";
  el.style.font = "600 12px/1.4 system-ui, sans-serif";
  el.style.padding = "2px 7px";
  el.style.borderRadius = "5px";
  el.style.border = `1px solid #${accent.toString(16).padStart(6, "0")}`;
  el.style.whiteSpace = "nowrap";
  el.style.transform = "translate(-50%, -140%)";
  return el;
}

export function useMeasureTool(
  components: Components,
  worldRef: MutableRefObject<World | null> | undefined,
  mode: MeasureMode,
  snapEnabled: boolean,
) {
  useEffect(() => {
    const world = worldRef?.current;
    if (!world || !world.renderer) return;
    const active = mode !== null;

    const marker = components.get(Marker);
    const highlighter = components.get(Highlighter);
    const fragments = components.get(FragmentsManager);
    const canvas = world.renderer.three.domElement;
    const capacity = mode === "angle" ? 3 : 2;

    // --- overlay state ------------------------------------------------------
    const group = new THREE.Group();
    group.renderOrder = 999;
    world.scene.three.add(group);

    const committedMarkerIds: string[] = [];
    const previewMarkerIds: string[] = [];
    const points: THREE.Vector3[] = [];

    const requestRender = () => {
      world.renderer!.needsUpdate = true;
    };

    const clearMarkers = (ids: string[]) => {
      for (const id of ids) marker.delete(id);
      ids.length = 0;
    };

    const disposeGroup = () => {
      for (const child of [...group.children]) {
        group.remove(child);
        const line = child as THREE.Line;
        line.geometry?.dispose();
        const mat = line.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    };

    const addLine = (from: THREE.Vector3, to: THREE.Vector3, color: number, dashed: boolean) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const material = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.2, gapSize: 0.12, depthTest: false, transparent: true })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      const line = new THREE.Line(geometry, material);
      if (dashed) line.computeLineDistances();
      line.renderOrder = 999;
      group.add(line);
    };

    const addMarker = (ids: string[], element: HTMLElement, at: THREE.Vector3) => {
      const id = marker.create(world, element, at.clone(), true);
      if (id) ids.push(id);
    };

    // Redraw everything committed so far (dots, legs, readouts).
    const drawCommitted = () => {
      disposeGroup();
      clearMarkers(committedMarkerIds);

      for (const p of points) addMarker(committedMarkerIds, makeDot(COMMITTED_COLOR), p);
      for (let i = 1; i < points.length; i++) {
        addLine(points[i - 1], points[i], COMMITTED_COLOR, false);
        // Angle mode measures only the angle: draw the legs as its rays but
        // skip their length labels (that readout belongs to distance mode).
        if (mode === "angle") continue;
        const mid = new THREE.Vector3().addVectors(points[i - 1], points[i]).multiplyScalar(0.5);
        addMarker(committedMarkerIds, makeReadout(formatLength(points[i - 1].distanceTo(points[i])), COMMITTED_COLOR), mid);
      }
      if (mode === "angle" && points.length === 3) {
        const deg = angleAtDeg(points[0], points[1], points[2]);
        addMarker(committedMarkerIds, makeReadout(`${deg.toFixed(1)}°`, COMMITTED_COLOR), points[1]);
      }
      requestRender();
    };

    const clearPreview = () => {
      // Remove preview lines (tagged via userData.preview) and preview markers;
      // committed lines are left untouched.
      for (const child of [...group.children]) {
        if (child.userData?.preview) {
          group.remove(child);
          const line = child as THREE.Line;
          line.geometry?.dispose();
          (line.material as THREE.Material)?.dispose();
        }
      }
      clearMarkers(previewMarkerIds);
      requestRender();
    };

    const drawPreview = (cursor: THREE.Vector3) => {
      clearPreview();
      // A completed measurement shows no preview.
      if (points.length >= capacity) return;

      if (points.length === 0) {
        // Nothing to connect yet, but when snapping is on, show the snap-target
        // dot from the very first hover — so the FIRST point can be aimed at a
        // corner with the same visual confirmation the later points get.
        if (snapEnabled) {
          addMarker(previewMarkerIds, makeDot(PREVIEW_COLOR, true), cursor);
          requestRender();
        }
        return;
      }

      const anchor = points[points.length - 1];

      const geometry = new THREE.BufferGeometry().setFromPoints([anchor, cursor]);
      const material = new THREE.LineDashedMaterial({
        color: PREVIEW_COLOR,
        dashSize: 0.2,
        gapSize: 0.12,
        depthTest: false,
        transparent: true,
      });
      const line = new THREE.Line(geometry, material);
      line.computeLineDistances();
      line.renderOrder = 999;
      line.userData.preview = true;
      group.add(line);

      addMarker(previewMarkerIds, makeDot(PREVIEW_COLOR, true), cursor);

      // Live readout: in angle mode surface only the angle, and only once both
      // legs exist (2 points down + the live cursor as the third) — the first
      // leg shows no length. In distance mode, the pending leg's length.
      if (mode === "angle") {
        if (points.length === 2) {
          const deg = angleAtDeg(points[0], points[1], cursor);
          addMarker(previewMarkerIds, makeReadout(`${deg.toFixed(1)}°`, PREVIEW_COLOR), points[1]);
        }
      } else {
        const mid = new THREE.Vector3().addVectors(anchor, cursor).multiplyScalar(0.5);
        addMarker(previewMarkerIds, makeReadout(formatLength(anchor.distanceTo(cursor)), PREVIEW_COLOR), mid);
      }
      requestRender();
    };

    const clearAll = () => {
      points.length = 0;
      clearPreview();
      disposeGroup();
      clearMarkers(committedMarkerIds);
      requestRender();
    };

    // --- picking ------------------------------------------------------------
    const pickPoint = async (clientX: number, clientY: number): Promise<THREE.Vector3 | null> => {
      try {
        const result = await fragments.raycast({
          camera: world.camera.three,
          dom: canvas,
          mouse: new THREE.Vector2(clientX, clientY),
          snappingClasses: snapEnabled ? [SnappingClass.POINT] : undefined,
        });
        return result?.point ? result.point.clone() : null;
      } catch {
        return null;
      }
    };

    const handlePick = async (clientX: number, clientY: number) => {
      const p = await pickPoint(clientX, clientY);
      if (!p) return;
      if (points.length >= capacity) points.length = 0; // start a fresh measurement
      points.push(p);
      clearPreview();
      drawCommitted();
    };

    // If inactive, we still want the effect's cleanup to have torn down the
    // previous activation — so only wire listeners when active.
    if (!active) {
      world.scene.three.remove(group);
      return () => undefined;
    }

    // Suppress element selection while measuring; restored on cleanup.
    const hadHighlighter = highlighter.enabled;
    highlighter.enabled = false;

    // --- keep close-up geometry from being sliced by the near clip plane ---
    // Dollying in to pick a corner can push members closer than the camera's
    // near plane, which cuts them open (the user sees the hollow section). The
    // near plane already follows the orbit distance (adaptive-near.ts, at 5 %);
    // measuring goes further in, so while armed, size the near plane to the
    // camera's distance-to-target so the focused geometry never clips no matter
    // how close you zoom, and restore it on exit. Capped at the original near
    // (never worse depth precision than default when zoomed out) and floored so
    // it can't reach zero.
    const controls = world.camera.controls;
    const savedNear = (world.camera.three as THREE.PerspectiveCamera).near;
    const applyMeasureNear = () => {
      const cam = world.camera.three as THREE.PerspectiveCamera;
      if (!cam.isPerspectiveCamera) return;
      const target = Math.min(savedNear, Math.max(0.001, controls.distance * 0.01));
      if (cam.near !== target) {
        cam.near = target;
        cam.updateProjectionMatrix();
        requestRender();
      }
    };
    applyMeasureNear();
    controls.addEventListener("update", applyMeasureNear);

    let downX = 0;
    let downY = 0;
    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };

    // Capture-phase so this runs before use-viewer-navigation's canvas 'click'
    // (which would otherwise re-aim the orbit pivot at the picked point).
    const onClickCapture = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
      if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_MOVE_PX) return; // was a drag
      event.stopImmediatePropagation();
      event.preventDefault();
      void handlePick(event.clientX, event.clientY);
    };

    let previewInFlight = false;
    const onPointerMove = async (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
      if (points.length >= capacity) return; // measurement complete — no preview
      // Before the first point there's only ever the snap-target indicator to
      // show, so skip the per-move raycast entirely when snapping is off.
      if (points.length === 0 && !snapEnabled) return;
      if (previewInFlight) return; // one snap raycast at a time — cheap throttle
      previewInFlight = true;
      const p = await pickPoint(event.clientX, event.clientY);
      previewInFlight = false;
      if (p) drawPreview(p);
      else clearPreview();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") clearAll();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClickCapture, true);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClickCapture, true);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      controls.removeEventListener("update", applyMeasureNear);
      const cam = world.camera.three as THREE.PerspectiveCamera;
      if (cam.isPerspectiveCamera && cam.near !== savedNear) {
        cam.near = savedNear;
        cam.updateProjectionMatrix();
      }
      clearMarkers(committedMarkerIds);
      clearMarkers(previewMarkerIds);
      disposeGroup();
      world.scene.three.remove(group);
      highlighter.enabled = hadHighlighter;
      requestRender();
    };
  }, [components, worldRef, mode, snapEnabled]);
}
