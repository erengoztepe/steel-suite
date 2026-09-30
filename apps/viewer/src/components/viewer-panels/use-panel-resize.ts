"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Width (px) of the thin grab strip a collapsed panel leaves behind. */
export const COLLAPSED_WIDTH = 28;

/**
 * Pointer travel (px) inward from a collapsed panel's grab strip before the
 * pull counts as "expand" rather than a click — big enough that a click with a
 * shaky hand doesn't pop the panel open, small enough that a deliberate pull
 * feels immediate.
 */
const EXPAND_THRESHOLD_PX = 8;

/**
 * How close to the collapsed strip the dragged edge has to get before the panel
 * snaps shut. Deliberately a short hop, NOT `minWidth`: snapping at the minimum
 * made a wide panel (the results screen's minimum is several hundred px) leap
 * shut from far away. The edge instead keeps following the pointer all the way
 * down — squeezed narrower than `minWidth`, which no longer applies once the
 * gesture is clearly a close — and only the last stretch is a snap.
 */
const COLLAPSE_SNAP_PX = 40;

/**
 * Collapse threshold for an OPEN panel being narrowed, as a fraction of that
 * panel's own `minWidth` (A). Releasing below `A * ratio` collapses; releasing
 * between `A * ratio` and A settles AT A. A panel therefore never rests narrower
 * than its minimum — but the edge is free to travel below it during the drag, so
 * the collapse gesture stays reachable. Relative to A rather than a fixed pixel
 * count so every panel gets a proportional dead zone.
 */
const OPEN_COLLAPSE_RATIO = 2 / 3;

/**
 * When a COLLAPSED panel is PULLED open (a drag, not a tap), the release resolves
 * by how far it was pulled, where A is that panel's own `minWidth`:
 *   < PULL_OPEN_MIN_WIDTH        → too short a pull, stay collapsed
 *   PULL_OPEN_MIN_WIDTH .. A     → open, but snap to `defaultWidth`
 *   >= A                         → open at exactly the pulled width
 * Only the closed→pull gesture is affected — tap-to-open and open-panel resizing
 * are untouched. Fixed px, not scaled.
 */
const PULL_OPEN_MIN_WIDTH = 80;

/**
 * Master switch for the drag SNAPS — mid-drag pull-to-collapse (the short hop at
 * COLLAPSE_SNAP_PX) and the results panel's snap-back-to-`defaultWidth`.
 * Temporarily OFF by request: the ONLY snap kept is tap-to-open on a collapsed
 * panel (handled in `onEnd`). While off, an open edge simply tracks the pointer
 * and the release either rests where left or collapses below
 * the open-panel collapse threshold. Flip to true to restore both drag snaps.
 */
const ENABLE_DRAG_SNAPS = false;

/**
 * Velocity-based fling-to-collapse. A fast NARROWING flick collapses the panel
 * regardless of where it is released — a velocity gesture, not a position one.
 * `FLING_COLLAPSE_VELOCITY` is the inward pointer speed (px/ms; narrowing is
 * negative, so the test is `inwardVelocity <= -FLING_COLLAPSE_VELOCITY`) that
 * counts as a fling — well above a brisk normal drag (~0.5–1 px/ms).
 * `FLING_MAX_GAP_MS` discards a stale velocity when the pointer paused before
 * release, so a slow release after a fast move isn't mistaken for a fling.
 */
const FLING_COLLAPSE_VELOCITY = 1.5;
const FLING_MAX_GAP_MS = 80;

/**
 * Flip to true to log every drag resolution to the console (`[panel-resize]`) —
 * the end event type, the release width, and the branch taken. Diagnoses "why
 * did it settle there" reports without guesswork.
 */
const DEBUG_PANEL_RESIZE = true;

/**
 * Width animation for the collapse/expand toggles (click, chevron), long and
 * decelerating enough that a panel hundreds of px wide unfolds rather than
 * snapping open. Never applied while dragging — see `isDragging`.
 */
export const PANEL_WIDTH_TRANSITION =
  "transition-[width] duration-[280ms] ease-[cubic-bezier(0.22,0.61,0.36,1)]";

interface PanelResizeOptions {
  /** Which edge the panel is anchored to — decides which pointer direction widens it. */
  side: "left" | "right";
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  defaultCollapsed: boolean;
  /**
   * "Snap back to default" resize mode (used by the results panel). When true,
   * dragging the edge never pulls the panel CLOSED: a release narrower than
   * `minWidth` snaps back to `defaultWidth` (the compact default) and stays
   * open, while anything `minWidth` or wider rests exactly where released.
   * Collapsing stays available via the header chevron. When false/undefined the
   * panel keeps the pull-to-collapse behavior.
   */
  snapBackToDefault?: boolean;
}

interface PanelResizeState {
  width: number;
  isCollapsed: boolean;
  isDragging: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
  /** Set the open width directly — for a programmatic resize, never a drag. */
  setWidth: (width: number) => void;
  /** Attach to the resize handle(s) — collapsed strip and open edge alike. */
  onHandlePointerDown: (e: React.PointerEvent) => void;
}

/**
 * Drag-to-resize / pull-to-collapse behavior shared by the Left and Right
 * panel shells (mirror images of each other, so the logic lives here once).
 *
 * Two things make the drag feel smooth, and both are load-bearing:
 *
 *  - Move/up are tracked on `window`, NOT via pointer capture on the handle.
 *    Expanding or collapsing mid-drag swaps the shell's collapsed and open
 *    branches, which unmounts the handle the pointer was captured by and used
 *    to kill the drag halfway through.
 *  - Moves are coalesced into one `requestAnimationFrame` per frame, so a
 *    high-polling-rate mouse can't queue several React renders per painted
 *    frame.
 *
 * The caller must also suppress its width transition while `isDragging` — an
 * eased width animation chasing the pointer reads as lag.
 */
export function usePanelResize({
  side,
  minWidth,
  maxWidth,
  defaultWidth,
  defaultCollapsed,
  snapBackToDefault = false,
}: PanelResizeOptions): PanelResizeState {
  const [dragWidth, setDragWidth] = useState(defaultWidth);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<{
    startX: number;
    /** Width the pointer's travel is measured from — the CURRENT on-screen width, never a remembered one. */
    startWidth: number;
    /**
     * The panel's last settled width, restored whenever this gesture ends
     * without leaving it at a usable width — so reopening always comes back to
     * the size the user actually chose, not to some width the pointer passed
     * through on its way to closing.
     */
    widthBeforeDrag: number;
    startedCollapsed: boolean;
    /** Set once a pull-open has crossed the expand threshold. */
    opened: boolean;
    /**
     * Whether the collapse snap is live. Off for the first stretch of a
     * pull-open — the panel starts out inside the snap distance by definition,
     * and would otherwise fold straight back up — armed as soon as the width
     * reaches `minWidth`.
     */
    snapArmed: boolean;
    /** Latest width this gesture produced, needed to resolve it on release. */
    lastWidth: number;
    /**
     * Widest the panel got at any point during this gesture. Distinguishes a
     * panel that was genuinely opened wide and then narrowed (→ collapse, like
     * "open + narrow") from a small pull-open that never got wide (→ the
     * closed-pull bands: snap-to-default / stay-closed). Without it a single
     * gesture that pulls open THEN narrows would wrongly snap to default.
     */
    peakWidth: number;
  } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Keeps the drag from turning into a text selection / native image drag.
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        // Measuring from the collapsed strip's own width — not from the width
        // the panel last had while open — is what keeps the edge under the
        // pointer. Anchoring to the remembered width made the panel leap
        // hundreds of px the moment the pull crossed the threshold.
        startWidth: isCollapsed ? COLLAPSED_WIDTH : dragWidth,
        widthBeforeDrag: dragWidth,
        startedCollapsed: isCollapsed,
        opened: false,
        snapArmed: !isCollapsed,
        lastWidth: isCollapsed ? COLLAPSED_WIDTH : dragWidth,
        peakWidth: isCollapsed ? COLLAPSED_WIDTH : dragWidth,
      };
      setIsDragging(true);
    },
    [dragWidth, isCollapsed],
  );

  // Inward pointer direction: rightward widens a left-anchored panel,
  // leftward widens a right-anchored one.
  const inward = side === "left" ? 1 : -1;

  useEffect(() => {
    if (!isDragging) return;

    let frame: number | null = null;
    let latestX = dragRef.current?.startX ?? 0;
    // Pointer-velocity tracking for fling-to-collapse. inwardVelocity is px/ms
    // in the panel's widen direction, so a narrowing flick is negative.
    let prevX = latestX;
    let prevT = 0;
    let inwardVelocity = 0;
    /**
     * Whether a real pointermove was seen. The release position is then taken
     * from `latestX` (the last move) rather than the end event's own clientX:
     * `pointercancel` — which the browser fires when the shell swaps its
     * collapsed/open branches mid-drag and unmounts the handle — can carry the
     * ORIGINAL press coordinates, making travel ≈ 0 and resolving the gesture to
     * "rest at the pre-drag width". That is the "snaps back to the old length"
     * bug; pointerup coords equal the last move anyway, so this is safe for both.
     */
    let sawMove = false;

    const apply = () => {
      frame = null;
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (latestX - drag.startX) * inward;

      if (drag.startedCollapsed && !drag.opened) {
        if (dx <= EXPAND_THRESHOLD_PX) return;
        drag.opened = true;
        setIsCollapsed(false);
        // No re-anchoring: travel stays measured from the original press, so
        // the panel edge keeps tracking the pointer instead of trailing it.
      }

      // The edge tracks the pointer freely all the way down to the collapsed
      // strip — `minWidth` is NOT a floor during the drag. Enforcing it here
      // would make the collapse gesture unreachable (every minWidth is wider
      // than the collapse threshold); it is applied when the gesture ENDS, where
      // a release under the minimum either settles at it or collapses.
      const next = Math.max(COLLAPSED_WIDTH, Math.min(maxWidth, drag.startWidth + dx));
      drag.peakWidth = Math.max(drag.peakWidth, next);
      if (!drag.snapArmed) {
        if (next >= minWidth) drag.snapArmed = true;
        drag.lastWidth = next;
        setDragWidth(next);
        return;
      }
      if (ENABLE_DRAG_SNAPS && !snapBackToDefault && next <= COLLAPSED_WIDTH + COLLAPSE_SNAP_PX) {
        // Squeezed down to the last short hop — snap shut and end the drag, so
        // the pointer has to be released and re-pressed to pull it back open.
        // Skipped in snap-back mode: there the edge just keeps following the
        // pointer and a too-narrow release resolves to the default on `onEnd`.
        dragRef.current = null;
        setIsCollapsed(true);
        setDragWidth(drag.widthBeforeDrag);
        setIsDragging(false);
        return;
      }
      drag.lastWidth = next;
      setDragWidth(next);
    };

    const onMove = (e: PointerEvent) => {
      const dt = prevT === 0 ? 0 : e.timeStamp - prevT;
      if (dt > 0) inwardVelocity = ((e.clientX - prevX) * inward) / dt;
      prevX = e.clientX;
      prevT = e.timeStamp;
      latestX = e.clientX;
      sawMove = true;
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const onEnd = (e: PointerEvent) => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      const drag = dragRef.current;
      if (!drag) {
        setIsDragging(false);
        return;
      }

      // Use the last real move position, not the end event's clientX (see
      // `sawMove`) — a pointercancel can report the original press coordinates.
      const endX = sawMove ? latestX : e.clientX;
      const travel = (endX - drag.startX) * inward;

      // Tap on the collapsed strip (no real pull) → open to the remembered
      // width. This is the ONLY place the pre-drag width is honoured, and only
      // for a genuine tap.
      if (drag.startedCollapsed && !drag.opened && travel <= EXPAND_THRESHOLD_PX) {
        setIsCollapsed(false);
        dragRef.current = null;
        setIsDragging(false);
        return;
      }

      // A real drag. The release width is computed DIRECTLY from the pointer-up
      // position — never `drag.lastWidth` (a stale rAF frame that occasionally
      // still held `startWidth` and made the panel "snap back to the old
      // length"). This is the single source of truth for the resolution.
      if (drag.startedCollapsed && !drag.opened) setIsCollapsed(false);
      const releaseWidth = Math.max(COLLAPSED_WIDTH, Math.min(maxWidth, drag.startWidth + travel));
      // Every band below is measured against this panel's own minimum (A), not a
      // fixed pixel count, so each panel scales with its own bounds.
      const A = minWidth;
      const openCollapseBelow = A * OPEN_COLLAPSE_RATIO;
      const everWide = Math.max(drag.peakWidth, releaseWidth) >= A;

      const stale = prevT === 0 || e.timeStamp - prevT > FLING_MAX_GAP_MS;
      const flungClosed = !stale && inwardVelocity <= -FLING_COLLAPSE_VELOCITY;

      // Resolve to either a collapse or an OPEN resting width. `width` never
      // falls back to the pre-drag width, and a collapse leaves the width alone
      // — so no gesture ever "snaps" to a remembered or default size, except the
      // deliberate closed-pull band below.
      let collapse = false;
      let width = releaseWidth;

      if (flungClosed) {
        collapse = true; // fast narrowing flick, wherever it was released
      } else if (drag.startedCollapsed) {
        // Pulled open from collapsed.
        if (releaseWidth >= A) {
          width = releaseWidth; // rest at the pulled width
        } else if (everWide) {
          collapse = true; // reached A then pulled back under it → collapse
        } else if (releaseWidth >= PULL_OPEN_MIN_WIDTH) {
          width = defaultWidth; // small pull [PULL_OPEN_MIN_WIDTH, A) → default
        } else {
          collapse = true; // tiny pull → stay collapsed
        }
      } else if (releaseWidth < openCollapseBelow) {
        collapse = true; // open panel narrowed below A*ratio → collapse
      } else if (releaseWidth < A) {
        width = A; // narrowed into [A*ratio, A) → settle AT the minimum
      }

      if (DEBUG_PANEL_RESIZE) {
        // eslint-disable-next-line no-console
        console.log("[panel-resize]", {
          side,
          event: e.type,
          startedCollapsed: drag.startedCollapsed,
          startWidth: Math.round(drag.startWidth),
          travel: Math.round(travel),
          releaseWidth: Math.round(releaseWidth),
          peakWidth: Math.round(drag.peakWidth),
          A: minWidth,
          thresholds:
            `open: collapse<${Math.round(openCollapseBelow)} settleAtA<${A}` +
            ` | pull: default>=${PULL_OPEN_MIN_WIDTH} rest>=${A} | tap<=${EXPAND_THRESHOLD_PX}`,
          velocity: Number(inwardVelocity.toFixed(2)),
          flungClosed,
          result: collapse ? "COLLAPSE" : `open@${Math.round(width)}`,
        });
      }
      if (collapse) {
        // Collapse. The width is NOT reset to `defaultWidth` nor restored to the
        // pre-drag width — both were unrequested resizes. It is only lifted to
        // the minimum when the drag ended below it, because a panel must never
        // reopen narrower than A (the same invariant the bands above enforce).
        setIsCollapsed(true);
        if (releaseWidth < A) setDragWidth(A);
      } else {
        setIsCollapsed(false);
        setDragWidth(width);
      }
      dragRef.current = null;
      setIsDragging(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    // Global cursor + selection lock: without these, dragging over the 3D
    // canvas or the table flickers the cursor and highlights text.
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (frame !== null) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isDragging, inward, minWidth, maxWidth, defaultWidth, snapBackToDefault]);

  // NOTE: there is deliberately NO effect re-clamping the width when the
  // caller's bounds change (window resize, screen switch). It used to pull a
  // narrow panel up to `minWidth` — a width change the user never asked for,
  // which read as an unexplained "snap". The width a drag settles on is now the
  // only thing that sets it. `maxWidth` is still enforced DURING a drag, so the
  // only way to end up wider than the current maximum is to shrink the window
  // afterwards; dragging the edge fixes that.

  return { width: dragWidth, isCollapsed, isDragging, setIsCollapsed, setWidth: setDragWidth, onHandlePointerDown };
}
