/**
 * Viewer mouse/keyboard navigation & selection.
 *
 * camera-controls only supports ONE static ACTION per mouse button
 * (`mouseButtons.left` / `.right`), so per-press, modifier-dependent gestures
 * are implemented by reassigning `mouseButtons.left`/`.right` (and a matching
 * speed multiplier) right before each press — from a `pointerdown` listener
 * registered on `window` in the CAPTURE phase. Capture-phase listeners on an
 * ancestor fire while the event is still travelling DOWN toward its target,
 * i.e. before camera-controls' own listener (attached directly to the canvas)
 * runs — so by the time camera-controls reads `mouseButtons`, we've already
 * set the right value for this particular press. The same capture-phase
 * trick is used for `wheel`, to vary zoom speed by modifier key.
 *
 * Full scheme:
 *   - Left drag, no modifier:  nothing
 *   - Left + Shift drag:       pan/truck, 1/1.2x the speed of a plain right-drag
 *   - Left + Ctrl (click):     add/remove one element (native Highlighter
 *                              `multiple = "ctrlKey"` + `autoToggle`, not
 *                              handled here) — re-clicking an already-selected
 *                              element deselects it.
 *   - Left + Ctrl drag:        rectangular box-select
 *   - Right drag, no modifier: pan/truck
 *   - Right + Shift drag:      orbit/rotate (no simultaneous pan — only one
 *                              ACTION is ever assigned to a button at a time)
 *   - Right + Ctrl drag:       pan/truck, 1.15x the speed of a plain right-drag
 *   - Left + Right held together: vertical (forward/back) mouse movement
 *     changes ONLY the camera's elevation; horizontal movement does nothing.
 *   - Middle drag:             nothing
 *   - Wheel:                   zoom/dolly, speed 0.36
 *   - Shift + wheel:           zoom/dolly, speed 0.2 (slower, precise)
 *   - Ctrl + wheel:            zoom/dolly, speed 0.5 (faster) — camera-controls
 *                              itself special-cases Ctrl+wheel (10x the deltaY,
 *                              for trackpad-pinch support), so the configured
 *                              dollySpeed here is pre-divided by that same
 *                              10x to land on the intended effective speed.
 *   - Single left-click on an element: selects it (native Highlighter
 *     click-select) and moves the orbit PIVOT there (`setTarget` — an alias
 *     of `setLookAt` that passes the CURRENT camera position back in as the
 *     position argument, so the camera provably doesn't move; only what it's
 *     aimed at changes. NOT `setOrbitPoint`, despite its name/docs suggesting
 *     the same thing — its actual implementation recomputes distance and
 *     calls `moveTo` internally, which DOES reposition the camera; that was
 *     the cause of the "camera suddenly jumps on a single click" bug).
 *   - Single left-click on empty space: clears the selection (native
 *     Highlighter behavior — no extra code needed here).
 *   - Rapid double-RIGHT-click on an element: the camera moves to a fixed
 *     focus distance from it. `moveTo` translates camera+target together, so
 *     azimuth/polar angles are mathematically unchanged (no "radical"
 *     reorientation), and both `moveTo`/`dollyTo` animate smoothly
 *     (enableTransition=true). The browser's native `click` event only fires
 *     for the left button, so this is detected manually (pointerdown/up pair
 *     on the right button with little enough movement between them to not be
 *     a pan drag) — see `onRightClick`.
 *   - Rapid triple-LEFT-click on EMPTY SPACE ONLY: recovery — frames the
 *     whole model in a fixed top-down (plan) view. A rapid triple-click that
 *     lands on an element does not trigger this (just the plain click
 *     behavior).
 *   - "Rapid" is judged by OUR OWN timestamp/distance check (RAPID_CLICK_MS/
 *     PX below), not the browser's native dblclick timing — two separate,
 *     deliberately-spaced clicks on the same spot are always two independent
 *     single clicks, never a double-click.
 */

import { useEffect } from "react";
import type { MutableRefObject } from "react";
import {
  Components,
  FragmentsManager,
  type ModelIdMap,
  OrthoPerspectiveCamera,
  Raycasters,
  SimpleRaycaster,
  SimpleScene,
  SimpleWorld,
} from "@thatopen/components";
import { Highlighter, type PostproductionRenderer } from "@thatopen/components-front";
import CameraControls from "camera-controls";
import * as THREE from "three";

import { frameToFitTopDown } from "./frame-to-fit";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

// Distance (m) at which speed scaling is neutral (1x) — matches the
// double-click focus distance so both behaviors agree on "normal".
const REFERENCE_DISTANCE = 10;
const FOCUS_DISTANCE = 10;
const MIN_SPEED_SCALE = 0.15;
const MAX_SPEED_SCALE = 6;

// Wheel dolly speeds (before distance scaling).
const WHEEL_DOLLY_SPEED = 0.36;
const WHEEL_SHIFT_DOLLY_SPEED = 0.2;
// camera-controls' own wheel handler special-cases Ctrl (10x the effective
// deltaY, meant for trackpad pinch-zoom) — divide our intended speed by that
// same factor so the EFFECTIVE zoom rate under Ctrl is what was asked for.
const WHEEL_CTRL_TARGET_SPEED = 0.5;
const WHEEL_CTRL_LIBRARY_DELTA_BOOST = 10;
const WHEEL_CTRL_DOLLY_SPEED = WHEEL_CTRL_TARGET_SPEED / WHEEL_CTRL_LIBRARY_DELTA_BOOST;

// Truck/rotate baselines (before distance scaling) — match camera-controls'
// own defaults.
const BASE_TRUCK_SPEED = 2;
const BASE_ROTATE_SPEED = 1;
const SHIFT_LEFT_PAN_FACTOR = 1 / 1.2; // 1.2x slower than a plain right-drag pan
const CTRL_RIGHT_PAN_FACTOR = 1.15; // 1.15x faster than a plain right-drag pan

// How much a full-canvas-height drag elevates the camera, relative to the
// current distance-to-target — keeps the feel consistent across zoom levels.
const ELEVATE_SENSITIVITY = 1;

// A drag shorter than this (px) is treated as a click, not a box-select.
const BOX_SELECT_MOVE_THRESHOLD = 4;

// Our own "was this a rapid follow-up click" window — deliberately NOT the
// browser's native dblclick timing (see file header).
const RAPID_CLICK_MS = 400;
const RAPID_CLICK_PX = 12;

/** Action + truck-speed multiplier for the LEFT button, given held modifiers. */
function leftButtonAction(event: { ctrlKey: boolean; shiftKey: boolean }) {
  if (event.ctrlKey) return { action: CameraControls.ACTION.NONE, truckFactor: 1 }; // box-select owns this drag
  if (event.shiftKey) return { action: CameraControls.ACTION.TRUCK, truckFactor: SHIFT_LEFT_PAN_FACTOR };
  return { action: CameraControls.ACTION.NONE, truckFactor: 1 };
}

/** Action + truck-speed multiplier for the RIGHT button, given held modifiers. */
function rightButtonAction(event: { ctrlKey: boolean; shiftKey: boolean }) {
  if (event.shiftKey) return { action: CameraControls.ACTION.ROTATE, truckFactor: 1 };
  if (event.ctrlKey) return { action: CameraControls.ACTION.TRUCK, truckFactor: CTRL_RIGHT_PAN_FACTOR };
  return { action: CameraControls.ACTION.TRUCK, truckFactor: 1 };
}

/**
 * The subset of a raycast hit this file needs. `SimpleRaycaster.castRay()`'s
 * declared return type is a plain `THREE.Intersection` — fragments augments
 * the actual object with `.fragments`/`.localId` at runtime (verified: this
 * is what `Highlighter.highlight()` itself reads), but that shape isn't in
 * the public `.d.ts`, hence the cast at the one call site below rather than
 * fighting the library's types to line up structurally.
 */
interface FragmentsHit {
  fragments?: { modelId: string; isDeltaModel?: boolean; parentModelId?: string };
}

/**
 * The modelId a raycast hit actually belongs to, delta-model indirection
 * included — mirrors the same resolution `Highlighter.highlight()` does
 * internally before building its selection map.
 */
function hitModelId(hit: FragmentsHit | null): string | null {
  const fragments = hit?.fragments;
  if (!fragments) return null;
  return (fragments.isDeltaModel ? fragments.parentModelId : fragments.modelId) ?? null;
}

/**
 * Makes click-driven selection treat a hidden file as click-through.
 *
 * `Highlighter.onMouseUp` (private, can't be reached directly) calls its own
 * `highlight()` with no `exclude` argument, and the raycast underneath it
 * (`SimpleRaycaster.castRay`, via `Raycasters`) has no concept of "hidden via
 * `object.visible`" at all — verified directly: hiding a model's root object
 * (the lever `toggleSourceVisibility` in StandaloneApp uses) stops it from
 * being DRAWN but not from being RAYCAST, so it stayed click-selectable.
 *
 * `highlight` is declared as a normal prototype method (unlike `onMouseUp`,
 * which is an arrow function assigned per-instance), so it can be shadowed on
 * the instance here without touching the vendored library. `highlightByID` —
 * the ID-based, non-raycast entry point every OTHER caller in this app uses
 * (Connection Library restore, Extract & Isolate, the "focus" double-click,
 * tag lookup) — is deliberately left untouched: those calls already know
 * their target ids and must keep working on hidden files, which is the whole
 * point of restoring a saved connection whose file you've since hidden.
 *
 * Returns an unpatch function.
 */
function patchHighlightForHiddenModels(
  highlighter: Highlighter,
  raycaster: SimpleRaycaster,
  hiddenModelIds: MutableRefObject<ReadonlySet<string>>,
): () => void {
  const original = highlighter.highlight.bind(highlighter);
  highlighter.highlight = (async (
    name: string,
    removePrevious = true,
    zoomToSelection = highlighter.zoomToSelection,
    exclude: ModelIdMap | null = null,
  ) => {
    const hit = (await raycaster.castRay()) as FragmentsHit | null;
    const modelId = hitModelId(hit);
    if (modelId && hiddenModelIds.current.has(modelId)) {
      // Same outcome as the original's own "raycast found nothing" branch.
      if (removePrevious) await highlighter.clear(name);
      return;
    }
    return original(name, removePrevious, zoomToSelection, exclude);
  }) as typeof highlighter.highlight;

  return () => {
    delete (highlighter as { highlight?: unknown }).highlight;
  };
}

export function useViewerNavigation(
  components: Components,
  worldRef: MutableRefObject<World | null>,
  ready: boolean,
  hiddenModelIdsRef: MutableRefObject<ReadonlySet<string>>,
) {
  useEffect(() => {
    const world = worldRef.current;
    if (!ready || !world?.camera || !world.renderer) return;

    const controls = world.camera.controls;
    const canvas = world.renderer.three.domElement;
    const raycaster = components.get(Raycasters).get(world);
    const highlighter = components.get(Highlighter);
    const fragmentsManager = components.get(FragmentsManager);
    const unpatchHighlight = patchHighlightForHiddenModels(highlighter, raycaster, hiddenModelIdsRef);

    let truckFactor = 1;
    let wheelDollySpeed = WHEEL_DOLLY_SPEED;

    const applyDistanceSpeed = () => {
      const scale = THREE.MathUtils.clamp(controls.distance / REFERENCE_DISTANCE, MIN_SPEED_SCALE, MAX_SPEED_SCALE);
      // Dolly is exponential/percentage-based internally (distance *= 0.95^k) —
      // already distance-proportional by construction, so an extra distance
      // multiplier here would COMPOUND with it: dollySpeed shrinking as you
      // approach makes the library's own percentage-per-tick shrink too
      // (strong deceleration zooming in), and growing as you recede makes the
      // percentage-per-tick grow too (runaway acceleration zooming out) — this
      // was the cause of zoom in/out feeling very disproportionate. Left flat.
      controls.dollySpeed = wheelDollySpeed;
      // Truck is already distance-proportional internally too (it multiplies
      // by targetDistance so a screen-space drag pans a consistent fraction of
      // the visible view regardless of zoom) — same double-scaling risk, so
      // also left flat.
      controls.truckSpeed = BASE_TRUCK_SPEED * truckFactor;
      // Rotate has NO native distance-dependence (angle-per-dragged-pixel is
      // constant in the library) — this scaling is ours entirely, so it's not
      // "double" anything. Kept as-is; flag if you'd rather it were flat too.
      controls.azimuthRotateSpeed = BASE_ROTATE_SPEED * scale;
      controls.polarRotateSpeed = BASE_ROTATE_SPEED * scale;
    };

    applyDistanceSpeed();
    controls.addEventListener("update", applyDistanceSpeed);

    const castRay = () => raycaster.castRay({ items: Array.from(world.meshes) });

    // --- wheel: modifier-dependent zoom speed (capture phase — see header) ---

    const onWheelCapture = (event: WheelEvent) => {
      if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
      wheelDollySpeed = event.ctrlKey
        ? WHEEL_CTRL_DOLLY_SPEED
        : event.shiftKey
          ? WHEEL_SHIFT_DOLLY_SPEED
          : WHEEL_DOLLY_SPEED;
      applyDistanceSpeed();
    };
    window.addEventListener("wheel", onWheelCapture, { capture: true, passive: true });

    // --- click: select (native) + pivot, plus OUR OWN rapid-click detection
    // for the double/triple-click behaviors (see file header for why) ---

    let lastClickTime = -Infinity;
    let lastClickPos = { x: 0, y: 0 };
    let rapidClickCount = 0;

    const onClick = (event: MouseEvent) => {
      const now = performance.now();
      const dx = event.clientX - lastClickPos.x;
      const dy = event.clientY - lastClickPos.y;
      const isRapidFollowUp = now - lastClickTime <= RAPID_CLICK_MS && Math.hypot(dx, dy) <= RAPID_CLICK_PX;
      rapidClickCount = isRapidFollowUp ? rapidClickCount + 1 : 1;
      lastClickTime = now;
      lastClickPos = { x: event.clientX, y: event.clientY };

      // Ctrl+click is purely a (native) multi-select add/remove/deselect-toggle
      // action — no pivot, no camera change, regardless of rapid-click count.
      if (event.ctrlKey) return;

      castRay().then((hit) => {
        if (!hit) {
          // Empty space: native Highlighter click-select already clears the
          // selection on a plain (non-Ctrl) click-with-no-hit. Also clear the
          // "focus" highlight explicitly here — `clear("select")` on an
          // ALREADY-empty selection may not fire an `onClear` event (nothing
          // to clear), so the select-events subscription alone isn't a
          // reliable trigger for this specific case. Recovery only applies
          // here too, on a genuinely empty-space rapid triple-click.
          clearFocusHighlight();
          if (rapidClickCount === 3) {
            frameToFitTopDown(world, true);
            rapidClickCount = 0;
          }
          return;
        }

        // Hit an element: every click (single or rapid) moves the pivot.
        // `setTarget` passes the camera's own current position back into
        // `setLookAt`, so camera POSITION is provably unchanged (unlike
        // `setOrbitPoint`, see header) — only the aim direction moves, which
        // is geometrically unavoidable when retargeting to an arbitrary point
        // while holding position fixed. enableTransition=true makes that
        // reaim a smooth ease rather than an instant snap, so it never reads
        // as a sudden "jump" — and since it settles on its own, starting an
        // orbit drag afterwards doesn't add any further jump either.
        void controls.setTarget(hit.point.x, hit.point.y, hit.point.z, true);

        if (rapidClickCount === 3) {
          // Triple-click on an element is explicitly NOT recovery — just reset
          // the burst counter so a further rapid click starts fresh. (The
          // rapid-double focus behavior lives on the RIGHT button now — see
          // onRightClick below.)
          rapidClickCount = 0;
        }
      });
    };

    canvas.addEventListener("click", onClick);

    // --- rapid double-RIGHT-click: focus on the clicked element ---
    // The browser's native 'click' event only fires for the left button, so
    // right-clicks are detected manually: a pointerdown/pointerup pair on the
    // right button with little enough movement between them to not be a pan
    // drag. Same rapid-follow-up window/threshold as the left-click burst
    // detector, but tracked independently (a right-click burst is unrelated
    // to a left-click burst).

    let rightClickDownPos: { x: number; y: number } | null = null;
    let lastRightClickTime = -Infinity;
    let lastRightClickPos = { x: 0, y: 0 };
    let rapidRightClickCount = 0;

    // The "focus" highlight marks the double-right-clicked element WITHOUT
    // selecting it (separate Highlighter style/group from "select" — doesn't
    // touch the actual selection, so use-member-selection's ordered list is
    // untouched). Cleared on the next rotate-drag or select action (see
    // clearFocusHighlight call sites below) — but NOT by pan or zoom.
    const clearFocusHighlight = () => {
      void highlighter.clear("focus");
    };

    const focusHighlightAt = async (clientX: number, clientY: number) => {
      for (const [modelId, model] of fragmentsManager.list) {
        const result = await model
          .raycast({ camera: world.camera.three, dom: canvas, mouse: new THREE.Vector2(clientX, clientY) })
          .catch(() => null);
        if (result?.localId != null) {
          await highlighter.highlightByID("focus", { [modelId]: new Set([result.localId]) }, true, false);
          return;
        }
      }
    };

    const onRightClick = (event: PointerEvent) => {
      const now = performance.now();
      const dx = event.clientX - lastRightClickPos.x;
      const dy = event.clientY - lastRightClickPos.y;
      const isRapidFollowUp = now - lastRightClickTime <= RAPID_CLICK_MS && Math.hypot(dx, dy) <= RAPID_CLICK_PX;
      rapidRightClickCount = isRapidFollowUp ? rapidRightClickCount + 1 : 1;
      lastRightClickTime = now;
      lastRightClickPos = { x: event.clientX, y: event.clientY };

      if (rapidRightClickCount !== 2) return;
      rapidRightClickCount = 0; // reset burst counter, matches the left-click burst behavior
      castRay().then((hit) => {
        if (!hit) return;
        // `moveTo` translates camera+target together (azimuth/polar
        // unchanged — no angle "jump"), then dolly to a fixed close
        // distance; both animate smoothly.
        controls.moveTo(hit.point.x, hit.point.y, hit.point.z, true);
        controls.dollyTo(FOCUS_DISTANCE, true);
        void focusHighlightAt(event.clientX, event.clientY);
      });
    };

    // --- box-select (Ctrl+Left drag) ---
    // A plain rectangle overlay + FragmentsModel.rectangleRaycast (native
    // rectangle/crossing hit-testing — no need to hand-roll frustum math).

    const boxEl = document.createElement("div");
    boxEl.style.position = "fixed";
    boxEl.style.zIndex = "50";
    boxEl.style.display = "none";
    boxEl.style.pointerEvents = "none";
    boxEl.style.border = "1px solid rgba(56, 189, 248, 0.9)";
    boxEl.style.background = "rgba(56, 189, 248, 0.15)";
    document.body.appendChild(boxEl);

    let boxSelectStart: { x: number; y: number } | null = null;
    let boxSelectDragging = false;

    const updateBoxEl = (x0: number, y0: number, x1: number, y1: number) => {
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      boxEl.style.left = `${left}px`;
      boxEl.style.top = `${top}px`;
      boxEl.style.width = `${Math.abs(x1 - x0)}px`;
      boxEl.style.height = `${Math.abs(y1 - y0)}px`;
    };

    const onPointerMoveBoxSelect = (event: PointerEvent) => {
      if (!boxSelectStart) return;
      const dx = event.clientX - boxSelectStart.x;
      const dy = event.clientY - boxSelectStart.y;
      if (!boxSelectDragging && Math.hypot(dx, dy) >= BOX_SELECT_MOVE_THRESHOLD) {
        boxSelectDragging = true;
        boxEl.style.display = "block";
      }
      if (boxSelectDragging) updateBoxEl(boxSelectStart.x, boxSelectStart.y, event.clientX, event.clientY);
    };

    const finishBoxSelect = async (endX: number, endY: number) => {
      const start = boxSelectStart;
      boxSelectStart = null;
      boxEl.style.display = "none";
      window.removeEventListener("pointermove", onPointerMoveBoxSelect);
      if (!start || !boxSelectDragging) return;
      boxSelectDragging = false;

      const topLeft = new THREE.Vector2(Math.min(start.x, endX), Math.min(start.y, endY));
      const bottomRight = new THREE.Vector2(Math.max(start.x, endX), Math.max(start.y, endY));

      const modelIdMap: Record<string, Set<number>> = {};
      for (const [modelId, model] of fragmentsManager.list) {
        // A hidden file is click-through for box-select too — same rule as
        // the plain-click path (see `patchHighlightForHiddenModels`), just
        // enforced here directly since this gesture calls `highlightByID`
        // itself rather than going through `Highlighter.highlight()`.
        if (hiddenModelIdsRef.current.has(modelId)) continue;
        // fullyIncluded=false: "crossing" selection — anything the rectangle
        // touches, not only elements fully enclosed by it.
        const result = await model
          .rectangleRaycast({ camera: world.camera.three, dom: canvas, topLeft, bottomRight, fullyIncluded: false })
          .catch(() => null);
        if (result?.localIds?.length) modelIdMap[modelId] = new Set(result.localIds);
      }

      if (Object.keys(modelIdMap).length === 0) return;
      await highlighter.highlightByID("select", modelIdMap, false, false);
    };

    const onPointerUpBoxSelect = (event: PointerEvent) => {
      if (event.button !== 0) return;
      void finishBoxSelect(event.clientX, event.clientY);
    };

    // --- Left+Right held together: vertical drag = elevation only ---

    let elevateChordActive = false;
    let elevateLastY = 0;

    const onPointerMoveElevate = (event: PointerEvent) => {
      if (!elevateChordActive) return;
      const dy = event.clientY - elevateLastY;
      elevateLastY = event.clientY;
      const rect = canvas.getBoundingClientRect();
      if (rect.height <= 0) return;
      // Dragging down moves the camera down, matching a "grab and pull" feel.
      // Horizontal movement is ignored entirely — elevation only.
      const heightDelta = -(dy / rect.height) * controls.distance * ELEVATE_SENSITIVITY;
      void controls.elevate(heightDelta, false);
    };

    // --- modifier-based button routing (capture phase — see file header) ---
    //
    // camera-controls re-reads `mouseButtons.left/right` on EVERY pointermove
    // (not just once at drag-start), so changing them mid-drag DOES take
    // effect immediately — we just also need to react to Shift/Ctrl changing
    // WHILE a button is already held (not just at the moment it's pressed),
    // which `onModifierKeyChange` below handles via `keydown`/`keyup`.

    let heldButtons = 0;

    const onPointerDownCapture = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !canvas.contains(event.target)) return;
      heldButtons = event.buttons;

      const bothHeld = (event.buttons & 1) !== 0 && (event.buttons & 2) !== 0;
      if (bothHeld) {
        // Elevation chord takes priority over everything else — neither
        // button drags the camera on its own while both are held.
        controls.mouseButtons.left = CameraControls.ACTION.NONE;
        controls.mouseButtons.right = CameraControls.ACTION.NONE;
        truckFactor = 1;
        elevateChordActive = true;
        elevateLastY = event.clientY;
        rightClickDownPos = null; // this press is part of a chord, not a right-click candidate
        applyDistanceSpeed();
        return;
      }

      if (event.button === 0) {
        if (event.ctrlKey) {
          controls.mouseButtons.left = CameraControls.ACTION.NONE; // box-select owns this drag, not the camera
          truckFactor = 1;
          boxSelectStart = { x: event.clientX, y: event.clientY };
          boxSelectDragging = false;
          window.addEventListener("pointermove", onPointerMoveBoxSelect);
        } else {
          const { action, truckFactor: f } = leftButtonAction(event);
          controls.mouseButtons.left = action;
          truckFactor = f;
        }
      } else if (event.button === 2) {
        const { action, truckFactor: f } = rightButtonAction(event);
        controls.mouseButtons.right = action;
        truckFactor = f;
        rightClickDownPos = { x: event.clientX, y: event.clientY };
        if (action === CameraControls.ACTION.ROTATE) clearFocusHighlight();
      }
      applyDistanceSpeed(); // apply the (possibly adjusted) speed immediately
    };

    const onPointerUpRightClick = (event: PointerEvent) => {
      if (event.button !== 2) return;
      const down = rightClickDownPos;
      rightClickDownPos = null;
      if (!down) return;
      // Only a right press+release with little enough movement counts as a
      // "right-click" — anything more is a pan/rotate drag, not a click.
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > BOX_SELECT_MOVE_THRESHOLD) return;
      onRightClick(event);
    };

    const onPointerUp = (event: PointerEvent) => {
      heldButtons = event.buttons;

      // If an elevation chord was active and one button was released, resume
      // whichever button (if any) is still held, based on current modifiers.
      if (elevateChordActive) {
        const bothStillHeld = (event.buttons & 1) !== 0 && (event.buttons & 2) !== 0;
        if (!bothStillHeld) {
          elevateChordActive = false;
          let f = 1;
          if (event.buttons & 1) {
            const r = leftButtonAction(event);
            controls.mouseButtons.left = r.action;
            f = r.truckFactor;
          }
          if (event.buttons & 2) {
            const r = rightButtonAction(event);
            controls.mouseButtons.right = r.action;
            f = r.truckFactor;
          }
          truckFactor = f;
          applyDistanceSpeed();
        }
        return;
      }

      if ((event.buttons & 1) === 0 && (event.buttons & 2) === 0) truckFactor = 1;
      applyDistanceSpeed();
    };

    // Live modifier reactivity: Shift/Ctrl pressed or released WHILE a button
    // is already held reassigns that button's action immediately (order of
    // button-press vs. modifier-press must not matter).
    const onModifierKeyChange = (event: KeyboardEvent) => {
      if (event.key !== "Shift" && event.key !== "Control") return;
      if (elevateChordActive || boxSelectStart) return; // chord/box-select own the drag exclusively
      const leftHeld = (heldButtons & 1) !== 0;
      const rightHeld = (heldButtons & 2) !== 0;
      if (leftHeld && !rightHeld) {
        const { action, truckFactor: f } = leftButtonAction(event);
        controls.mouseButtons.left = action;
        truckFactor = f;
        applyDistanceSpeed();
      } else if (rightHeld && !leftHeld) {
        const { action, truckFactor: f } = rightButtonAction(event);
        controls.mouseButtons.right = action;
        truckFactor = f;
        if (action === CameraControls.ACTION.ROTATE) clearFocusHighlight();
        applyDistanceSpeed();
      }
    };

    window.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointerup", onPointerUpBoxSelect);
    window.addEventListener("pointerup", onPointerUpRightClick);
    window.addEventListener("pointermove", onPointerMoveElevate);
    window.addEventListener("keydown", onModifierKeyChange);
    window.addEventListener("keyup", onModifierKeyChange);

    // Any change to the actual "select" group — a plain click-select, a
    // Ctrl+click add/toggle, or a box-select — clears the "focus" highlight
    // too (rotate-start clears it via clearFocusHighlight above; pan/zoom
    // never touch it).
    const subscribeSelectClearsFocus = (): (() => void) => {
      const selectEvents = highlighter.events?.select;
      if (!selectEvents) return () => undefined;
      selectEvents.onHighlight.add(clearFocusHighlight);
      selectEvents.onClear.add(clearFocusHighlight);
      return () => {
        selectEvents.onHighlight.remove(clearFocusHighlight);
        selectEvents.onClear.remove(clearFocusHighlight);
      };
    };
    let unsubscribeSelectClearsFocus = () => undefined as void;
    if (highlighter.isSetup) unsubscribeSelectClearsFocus = subscribeSelectClearsFocus();
    const onHighlighterSetup = () => {
      unsubscribeSelectClearsFocus = subscribeSelectClearsFocus();
    };
    highlighter.onSetup.add(onHighlighterSetup);

    return () => {
      controls.removeEventListener("update", applyDistanceSpeed);
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("wheel", onWheelCapture, true);
      window.removeEventListener("pointerdown", onPointerDownCapture, true);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointerup", onPointerUpBoxSelect);
      window.removeEventListener("pointerup", onPointerUpRightClick);
      window.removeEventListener("pointermove", onPointerMoveBoxSelect);
      window.removeEventListener("pointermove", onPointerMoveElevate);
      window.removeEventListener("keydown", onModifierKeyChange);
      window.removeEventListener("keyup", onModifierKeyChange);
      highlighter.onSetup.remove(onHighlighterSetup);
      unsubscribeSelectClearsFocus();
      clearFocusHighlight();
      unpatchHighlight();
      boxEl.remove();
    };
  }, [components, worldRef, ready, hiddenModelIdsRef]);
}
