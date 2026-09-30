"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Close } from "@/icons";
import { COLLAPSED_WIDTH, PANEL_WIDTH_TRANSITION, usePanelResize } from "./use-panel-resize";

const RIGHT_PANEL_DEFAULT_WIDTH = 380;

/**
 * Programmatic control for a screen switch that animates the panel itself (see
 * panel-motion.ts). Every call is timer-based, so it also completes in a
 * background tab where no frames are drawn.
 */
export interface RightPanelShellHandle {
  /** Move the open panel's width to `width` over `durationMs`, eased by `easing`. */
  animateWidth(width: number, durationMs: number, easing: string): Promise<void>;
  /**
   * Narrow the open panel shut over `durationMs`. The content is neither faded
   * nor reflowed: it keeps its width and rides out with the moving edge.
   */
  collapse(durationMs: number, easing: string): Promise<void>;
  /** Set the open width without animating — for a switch made while collapsed. */
  setWidth(width: number): void;
  isCollapsed(): boolean;
  /** The width the panel is drawn at right now, mid-animation included. */
  renderedWidth(): number;
}

interface RightPanelShellProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  resizable?: boolean;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  defaultCollapsed?: boolean;
  /** See `usePanelResize`'s `snapBackToDefault` — the results panel opts in. */
  snapBackToDefault?: boolean;
  outerClassName?: string;
  onWidthChange?: (width: number) => void;
}

export const RightPanelShell = forwardRef<RightPanelShellHandle, RightPanelShellProps>(function RightPanelShell(
  {
    title,
    onClose,
    children,
    width = RIGHT_PANEL_DEFAULT_WIDTH,
    resizable = false,
    minWidth = 320,
    maxWidth = 1400,
    defaultWidth = RIGHT_PANEL_DEFAULT_WIDTH,
    defaultCollapsed = true,
    snapBackToDefault = false,
    outerClassName = "",
    onWidthChange,
  },
  ref,
) {
  const { width: dragWidth, isCollapsed, isDragging, setIsCollapsed, setWidth, onHandlePointerDown } = usePanelResize({
    side: "right",
    minWidth,
    maxWidth,
    defaultWidth,
    defaultCollapsed,
    snapBackToDefault,
  });

  const outerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLDivElement>(null);
  const collapsedRef = useRef(isCollapsed);
  collapsedRef.current = isCollapsed;
  // A programmatic move's own width transition, standing in for the default
  // toggle one while it runs.
  const [transitionOverride, setTransitionOverride] = useState<string | null>(null);
  // Set while `collapse()` narrows the panel: the open content is held at the
  // width it had, anchored to the moving edge, instead of being squeezed.
  const [closing, setClosing] = useState<{ heldWidth: number } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      animateWidth(next, durationMs, easing) {
        flushSync(() => {
          setTransitionOverride(`width ${durationMs}ms ${easing}`);
          setWidth(next);
        });
        // Clearing the override early is harmless: a running CSS transition
        // keeps the parameters it started with.
        return new Promise((resolve) =>
          setTimeout(() => {
            setTransitionOverride(null);
            resolve();
          }, durationMs),
        );
      },
      collapse(durationMs, easing) {
        if (collapsedRef.current) return Promise.resolve();
        const heldWidth = openRef.current?.offsetWidth ?? 0;
        flushSync(() => {
          setTransitionOverride(`width ${durationMs}ms ${easing}`);
          setClosing({ heldWidth });
        });
        return new Promise((resolve) =>
          setTimeout(() => {
            setIsCollapsed(true);
            setClosing(null);
            setTransitionOverride(null);
            resolve();
          }, durationMs),
        );
      },
      setWidth,
      isCollapsed: () => collapsedRef.current,
      renderedWidth: () => outerRef.current?.offsetWidth ?? 0,
    }),
    [setIsCollapsed, setWidth],
  );

  const effectiveWidth = isCollapsed || closing ? COLLAPSED_WIDTH : resizable ? dragWidth : width;

  // Report the width the panel is actually DRAWN at, frame by frame, rather
  // than the width it is heading for — so whatever tracks this edge (the bottom
  // control bar) follows a width animation instead of jumping to where it ends.
  useEffect(() => {
    const el = outerRef.current;
    if (!el || !onWidthChange) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      onWidthChange(Math.round(box ? box.inlineSize : el.offsetWidth));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onWidthChange]);

  return (
    <div
      ref={outerRef}
      className={`flex flex-col absolute right-0 overflow-hidden items-end border-l border-l-border-primary z-10 ${
        // An eased width animation chasing the pointer reads as lag, so it's
        // only on for the collapse/expand toggles, never during a drag.
        isDragging || transitionOverride ? "" : PANEL_WIDTH_TRANSITION
      } ${outerClassName}`}
      style={{
        width: effectiveWidth ? `${effectiveWidth}px` : undefined,
        transition: transitionOverride ?? undefined,
        // Sits below the app's top bar (which sets --viewer-top-inset) instead
        // of underneath it — that bar is painted above this panel and would
        // otherwise swallow the header row, collapse chevron included.
        top: "var(--viewer-top-inset, 0px)",
        height: "calc(100% - var(--viewer-top-inset, 0px))",
      }}
    >
      {isCollapsed ? (
        <div
          className="flex flex-col h-full w-full bg-bg-secondary hover:bg-bg-tertiary cursor-pointer items-center justify-center border-l border-border-primary relative transition-colors group"
          // NO onClick when resizable — see LeftPanelShell for the full reason:
          // the strip mounts under the pointer the moment a drag collapses the
          // panel, so the browser's trailing `click` re-opened it instantly.
          // Tap-to-open is handled by usePanelResize via the overlay's
          // onPointerDown.
          onClick={resizable ? undefined : () => setIsCollapsed(false)}
          title="Click or pull to expand panel"
        >
          {resizable && (
            <div
              onPointerDown={onHandlePointerDown}
              className="absolute left-0 top-0 h-full w-full cursor-col-resize touch-none z-10"
            />
          )}
          <div className="w-1 h-12 bg-border-primary rounded-full group-hover:bg-brand-primary transition-colors" />
        </div>
      ) : (
        <div
          ref={openRef}
          className="relative flex flex-col gap-1 h-full w-full backdrop-blur-[4px] overflow-auto pointer-events-auto bg-bg-primary-transparent"
          // While closing: the held width, pinned to the LEFT (the moving edge)
          // — the outer column aligns items to the end, which would pin it to
          // the right and wipe the content away in place instead.
          style={closing ? { width: closing.heldWidth, flexShrink: 0, alignSelf: "flex-start" } : undefined}
        >
          {resizable && (
            <div
              onPointerDown={onHandlePointerDown}
              className="absolute left-0 top-0 h-full w-2 -translate-x-1/2 cursor-col-resize touch-none z-10 hover:bg-brand-primary/40"
              title="Drag to resize, pull right to collapse"
            />
          )}
          <div className="flex flex-col gap-2 h-full overflow-auto w-full">
            <div className="flex justify-between items-center p-2 shrink-0 border-b border-b-border-primary">
              <p className="text-base font-medium text-text-primary">{title}</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsCollapsed(true)}
                  className="p-1 text-text-secondary hover:text-text-primary transition-colors rounded hover:bg-bg-secondary flex items-center justify-center"
                  title="Collapse panel"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </button>
                {onClose && (
                  <Close
                    height={16}
                    width={16}
                    className="cursor-pointer text-text-secondary hover:text-text-primary transition-colors shrink-0 ml-1"
                    onClick={onClose}
                    aria-label={`Close ${title}`}
                  />
                )}
              </div>
            </div>
            {children}
          </div>
        </div>
      )}
    </div>
  );
});
