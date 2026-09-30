import { flushSync } from "react-dom";
import type { RightPanelShellHandle } from "./RightPanelShell";

/**
 * Motion for switching what a side panel shows (the Member Vectors selection ↔
 * results screens): the old content fades out, the panel's width moves, the new
 * content fades in — as one gesture, not three steps.
 *
 * Timings are the user's spec. The width move starts halfway through the fade
 * out and lands exactly as the fade in finishes, so the new content arrives
 * while the panel is still opening.
 */
export const CONTENT_OUT_MS = 200;
export const CONTENT_IN_MS = 400;
const PANEL_MOVE_START_MS = CONTENT_OUT_MS / 2;
const PANEL_MOVE_MS = CONTENT_OUT_MS - PANEL_MOVE_START_MS + CONTENT_IN_MS;
/** ✕ on the results screen: the panel narrows shut, the content NOT faded. */
export const PANEL_COLLAPSE_MS = 200;
/** Real content replacing a placeholder on the same screen. */
const CONTENT_FILL_MS = 200;

/** Accelerate away, decelerate in; the width uses the same ease-in-out as the 3D glide. */
const CONTENT_OUT_EASE = "cubic-bezier(0.4, 0, 1, 1)";
const CONTENT_IN_EASE = "cubic-bezier(0, 0, 0.2, 1)";
export const PANEL_MOVE_EASE = "cubic-bezier(0.65, 0, 0.35, 1)";

// A short VERTICAL rise: the width move is already horizontal motion, and a
// sideways slide on top of it competed with the moving edge. Opacity + transform
// only, so it keeps running even while the main thread is busy.
const CONTENT_OUT_KEYFRAMES: Keyframe[] = [
  { opacity: 1, transform: "translateY(0)" },
  { opacity: 0, transform: "translateY(-4px)" },
];
const CONTENT_IN_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "translateY(0)" },
];

// Wall-clock steps, not animation events: the sequence (and the state swap in
// it) must advance in a background tab too, where no frames are drawn.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Holds `body` at a fixed layout width (null releases it). While the panel's
 * width moves, content that followed it would reflow every frame — the results
 * toolbar changing its line count mid-animation — so it is laid out once, at
 * its final width, and simply rides the moving edge. The clip wrapper around it
 * cuts off the overhang instead of growing a scrollbar.
 */
function pin(body: HTMLElement, width: number | null): void {
  body.style.width = width === null ? "" : `${width}px`;
  if (body.parentElement) body.parentElement.style.overflowX = width === null ? "" : "clip";
}

/** Stops whatever a screen transition left on `body` — animations and the pin. */
export function settlePanelBody(body: HTMLElement | null): void {
  if (!body) return;
  for (const animation of body.getAnimations()) animation.cancel();
  pin(body, null);
}

export interface PanelScreenTransition {
  shell: RightPanelShellHandle;
  /** The element holding the screen's content; its parent is the clip wrapper. */
  body: HTMLElement;
  /** The panel width the new screen opens at. */
  targetWidth: number;
  /** Puts the new screen's content in place (run inside `flushSync`). */
  swap: () => void;
  /** False once a newer transition has taken over — this one stops at its next step. */
  isCurrent: () => boolean;
}

export async function runPanelScreenTransition({
  shell,
  body,
  targetWidth,
  swap,
  isCurrent,
}: PanelScreenTransition): Promise<void> {
  settlePanelBody(body);
  if (shell.isCollapsed()) {
    // Nothing on screen to animate.
    flushSync(swap);
    shell.setWidth(targetWidth);
    return;
  }

  pin(body, body.offsetWidth);
  const out = body.animate(CONTENT_OUT_KEYFRAMES, { duration: CONTENT_OUT_MS, easing: CONTENT_OUT_EASE, fill: "forwards" });
  await sleep(PANEL_MOVE_START_MS);
  if (!isCurrent()) return;
  const move = shell.animateWidth(targetWidth, PANEL_MOVE_MS, PANEL_MOVE_EASE);
  await sleep(CONTENT_OUT_MS - PANEL_MOVE_START_MS);
  if (!isCurrent()) return;

  // Swap, then size the new content for the FINAL panel width. The chrome
  // around the body (border, and a scrollbar if the new content brings one) is
  // measured now, with the new content in, so releasing the pin at the end
  // changes nothing on screen. All in one task: no frame in between shows the
  // new content before its fade-in has started.
  flushSync(swap);
  const clip = body.parentElement;
  const chrome = clip ? shell.renderedWidth() - clip.offsetWidth : 0;
  pin(body, targetWidth - chrome);
  out.cancel();
  body.animate(CONTENT_IN_KEYFRAMES, { duration: CONTENT_IN_MS, easing: CONTENT_IN_EASE });

  await Promise.all([sleep(CONTENT_IN_MS), move]);
  if (!isCurrent()) return;
  pin(body, null);
}

/** Replaces a placeholder with the real content on the same screen: a short fade, no movement. */
export function fillPanelBody(body: HTMLElement | null, swap: () => void): void {
  flushSync(swap);
  body?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CONTENT_FILL_MS, easing: CONTENT_IN_EASE });
}
