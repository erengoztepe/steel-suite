"use client";

import { useEffect } from "react";
import { Close } from "@/icons";
import { COLLAPSED_WIDTH, PANEL_WIDTH_TRANSITION, usePanelResize } from "./use-panel-resize";

const LEFT_PANEL_DEFAULT_WIDTH = 280;

interface LeftPanelShellProps {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  width?: number;
  resizable?: boolean;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  defaultCollapsed?: boolean;
  outerClassName?: string;
  onWidthChange?: (width: number) => void;
}

export function LeftPanelShell({
  title,
  onClose,
  children,
  width = LEFT_PANEL_DEFAULT_WIDTH,
  resizable = false,
  minWidth = 240,
  maxWidth = 800,
  defaultWidth = LEFT_PANEL_DEFAULT_WIDTH,
  defaultCollapsed = true,
  outerClassName = "",
  onWidthChange,
}: LeftPanelShellProps) {
  const { width: dragWidth, isCollapsed, isDragging, setIsCollapsed, onHandlePointerDown } = usePanelResize({
    side: "left",
    minWidth,
    maxWidth,
    defaultWidth,
    defaultCollapsed,
  });

  const effectiveWidth = isCollapsed ? COLLAPSED_WIDTH : resizable ? dragWidth : width;

  useEffect(() => {
    onWidthChange?.(effectiveWidth);
  }, [effectiveWidth, onWidthChange]);

  return (
    <div
      className={`flex flex-col absolute left-0 overflow-hidden items-start border-r border-r-border-primary z-10 ${
        // An eased width animation chasing the pointer reads as lag, so it's
        // only on for the collapse/expand toggles, never during a drag.
        isDragging ? "" : PANEL_WIDTH_TRANSITION
      } ${outerClassName}`}
      style={{
        width: effectiveWidth ? `${effectiveWidth}px` : undefined,
        // Sits below the app's top bar (which sets --viewer-top-inset) instead
        // of underneath it — that bar is painted above this panel and would
        // otherwise swallow the header row, collapse chevron included.
        top: "var(--viewer-top-inset, 0px)",
        height: "calc(100% - var(--viewer-top-inset, 0px))",
      }}
    >
      {isCollapsed ? (
        <div
          className="flex flex-col h-full w-full bg-bg-secondary hover:bg-bg-tertiary cursor-pointer items-center justify-center border-r border-border-primary relative transition-colors group"
          // NO onClick when resizable: the overlay below covers the whole strip
          // and routes every press through usePanelResize, which opens on a tap
          // itself. Keeping an onClick here re-opened the panel immediately after
          // a drag-to-collapse — the strip mounts under the pointer the instant
          // the panel folds, so the browser's trailing `click` (dispatched after
          // pointerup) landed on it. That read as "narrowing never collapses,
          // it just snaps back to the old width".
          onClick={resizable ? undefined : () => setIsCollapsed(false)}
          title="Click or pull to expand panel"
        >
          {resizable && (
            <div
              onPointerDown={onHandlePointerDown}
              className="absolute right-0 top-0 h-full w-full cursor-col-resize touch-none z-10"
            />
          )}
          <div className="w-1 h-12 bg-border-primary rounded-full group-hover:bg-brand-primary transition-colors" />
        </div>
      ) : (
        <div className="relative flex flex-col gap-1 h-full w-full backdrop-blur-[4px] overflow-auto pointer-events-auto bg-bg-primary-transparent">
          {resizable && (
            <div
              onPointerDown={onHandlePointerDown}
              className="absolute right-0 top-0 h-full w-2 translate-x-1/2 cursor-col-resize touch-none z-10 hover:bg-brand-primary/40"
              title="Drag to resize, pull left to collapse"
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
                    <polyline points="15 18 9 12 15 6"></polyline>
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
}
