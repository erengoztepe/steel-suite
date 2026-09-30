import {
  cloneElement,
  type MouseEvent as ReactMouseEvent,
  MutableRefObject,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Angle as AngleIcon,
  AreaMeasurement as AreaMeasurementIcon,
  BackView,
  Camera,
  CarrotDown,
  EyeHide,
  EyeShow,
  FrontView,
  LeftView,
  LengthMeasurement as LengthMeasurementIcon,
  Magnet,
  Mode,
  RightView,
  Ruler,
  SearchArea,
  SectionPlane,
  TopView,
  PerspectiveView,
  ParallelProjection,
} from "@/icons";
import { Components, type ModelIdMap, OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import { LengthMeasurement, Highlighter, PostproductionRenderer, AreaMeasurement } from "@thatopen/components-front";
import CameraControls from "camera-controls";
import * as THREE from "three";

import { isModelTintStyle } from "../../../model-tint";
import { useClipTool, PLANE_COLOR, type ClipAxis, type ClipSide, type ClipState } from "../use-clip-tool";
import { useMeasureTool, type MeasureMode } from "../use-measure-tool";
import { useTagLabels } from "../use-tag-labels";
import ClipAxisIcon from "./clip-axis-icon";
import { scaleFromWidth } from "./layout-scale";

interface SubPanelProps {
  children: ReactNode;
}

// TODO: Make sure to update colors once it's restored
const SubPanel = ({ children }: SubPanelProps) => (
  <div className="flex relative bg-bim-compliance-background-secondary border rounded-xl border-[#AFD8D433] flex-1 p-1 gap-1 backdrop-blur-[24px]">
    {children}
  </div>
);

interface SubActionProps {
  label: string;
  icon: ReactNode;
  /** Receives the click event so callers can read modifiers (Ctrl/Cmd). */
  onClick: (e: ReactMouseEvent) => void;
  /** Highlights this option as the currently-selected one within its sub-panel (e.g. the Tag/GUID label-identifier choice). */
  active?: boolean;
}

const SubAction = ({ label, icon, onClick, active }: SubActionProps) => (
  <div
    className={`relative flex flex-col min-w-12 items-center p-2.5 gap-1.5 cursor-pointer hover:bg-gradient-3 rounded-lg border ${
      active ? "border-bim-compliance-active-border bg-gradient-3" : "border-transparent"
    }`}
    onClick={onClick}
  >
    {icon}
    <p className="text-bim-compliance-text-secondary text-[10px] font-medium leading-[7px] tracking-[0]">{label}</p>
  </div>
);

/**
 * Minimum horizontal gap (px) this bar keeps from whatever it's avoiding on
 * its right, at the reference width (see layout-scale.ts) — scaled by the
 * live container width everywhere it's actually used below.
 */
const AVOID_GAP_PX_AT_REFERENCE = 80;

interface ControlPanelProps {
  components: Components;
  worldRef?: MutableRefObject<SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer> | null>;
  /**
   * Width (px) of a right-anchored panel this bar should stay clear of, or
   * `null` when none is relevant. The bar stays at its natural centered
   * position until the panel's left edge comes within the scaled avoid-gap of
   * it, then slides left in lockstep to hold that gap — sliding back as the
   * panel narrows, never past its natural centered position.
   */
  avoidRightEdgePx?: number | null;
  /**
   * How far in (px) from the container's LEFT edge the nearest thing on that
   * side reaches — the axis gizmo, or a wider left-anchored panel covering it.
   * The bar's leftward avoid-slide stops with the same scaled gap held clear of
   * it, so sliding out of the right panel's way can never push the bar onto
   * whatever sits bottom-left.
   */
  avoidLeftEdgePx?: number | null;
  /** Reports this bar's own current rendered width (px) — a sibling can use it to work out how much room to leave this bar. */
  onBarWidthChange?: (width: number) => void;
  /**
   * Photoshoot mode, owned by the host: this bar only offers the button, since
   * the mode hides the host's own chrome and gates the axis gizmo, neither of
   * which is this component's to touch. Escape leaves the mode (see the key
   * handler below) — and leaving is ALL Escape does in that case, so a
   * screenshot gesture never doubles as "clear my selection".
   */
  photoshoot?: boolean;
  onPhotoshootChange?: (on: boolean) => void;
}

const ControlPanel = ({
  components,
  worldRef,
  avoidRightEdgePx,
  avoidLeftEdgePx,
  onBarWidthChange,
  photoshoot = false,
  onPhotoshootChange,
}: ControlPanelProps) => {
  // Which action's sub-panel is currently shown on hover. Content is derived
  // from `actions` at render time (below) rather than snapshotted here, so a
  // click inside the sub-panel (e.g. picking Tag/GUID) is reflected
  // immediately — `actions` itself updates via useMemo when its state changes.
  const [hoveredLabel, setHoveredLabel] = useState<string>();
  const [actionRelativeXPox, setActionRelativeXPox] = useState<number>();
  // Which identifier the floating viewer labels show — null means labels are
  // off; "tag"/"guid" is picked directly via the Labels sub-panel below.
  const [labelIdentifier, setLabelIdentifier] = useState<"tag" | "guid" | null>(null);
  // Measurement tool: which mode is armed (null = off), and whether picks snap
  // to model corners. Snap defaults on — that's the reason to measure on a BIM
  // model rather than eyeball it.
  const [measureMode, setMeasureMode] = useState<MeasureMode>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  // Clipping tool: which of the six axis planes are on (drives the "Clipping"
  // highlight + button icons) and whether 3-point picking is armed. The grid is
  // a separate datum, not a clip — its visibility mirror lives here only for the
  // "Grid > Hide/Show" sub-action label + highlight (the grid defaults on).
  const [clipState, setClipState] = useState<ClipState>({
    XY: { a: false, b: false },
    XZ: { a: false, b: false },
    YZ: { a: false, b: false },
    threePoint: false,
    hasAny: false,
  });
  const [threePoint, setThreePoint] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const keepYUpCleanupRef = useRef<() => void>();

  const highlighter = components.get(Highlighter);
  const lengthMeasurer = components.get(LengthMeasurement);
  const areaMeasurer = components.get(AreaMeasurement);

  // This bar's own rendered width — needed (alongside viewport width) to work
  // out its natural centered position, since it's sized by its content
  // (number of actions) rather than a fixed value.
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => setBarWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onBarWidthChange?.(barWidth);
  }, [barWidth, onBarWidthChange]);

  // Width of the shared positioning container (both this bar and the right
  // panel are `absolute` inside the same relatively-positioned app root), so
  // this is the basis for both "centered" and "right-anchored" math below.
  // Measured directly off that ancestor rather than tracked via a window
  // "resize" listener — robust to layout changes that don't fire one (embedding,
  // zoom, programmatic viewport changes).
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = parentRef.current?.offsetParent as HTMLElement | null;
    if (!el) return;
    const update = () => setContainerWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // How far left (px, <= 0) to shift off the natural centered position to
  // keep the (scaled) avoid-gap clear of the right-anchored panel. Computed
  // fresh from current geometry each time (not incremental), so it tracks a
  // live drag exactly and never overshoots past the natural position.
  const avoidShiftPx = useMemo(() => {
    if (!barWidth || !containerWidth) return 0;
    const avoidGapPx = AVOID_GAP_PX_AT_REFERENCE * scaleFromWidth(containerWidth);
    const naturalLeft = containerWidth / 2 - barWidth / 2;
    // The free corridor this bar has to live inside: the scaled gap clear of
    // the right panel's leading edge on one side, and clear of whatever sits
    // bottom-left (the axis gizmo, or a left panel covering it) on the other.
    const corridorLeft = (avoidLeftEdgePx ?? 0) + avoidGapPx;
    const corridorRight = (avoidRightEdgePx ? containerWidth - avoidRightEdgePx : containerWidth) - avoidGapPx;
    // Natural centered position, then pushed just far enough to stay inside
    // that corridor — left when the right panel encroaches, right when a left
    // panel does. Order matters: the left obstacle wins a genuine squeeze,
    // since the right panel's own max width is capped at exactly the point
    // where the corridor runs out, so the two only ever disagree on a window
    // too narrow to honor both gaps at all.
    const left = Math.max(corridorLeft, Math.min(naturalLeft, corridorRight - barWidth));
    return left - naturalLeft;
  }, [avoidRightEdgePx, avoidLeftEdgePx, barWidth, containerWidth]);

  useTagLabels(components, worldRef, labelIdentifier !== null, labelIdentifier ?? "tag");
  useMeasureTool(components, worldRef, measureMode, snapEnabled);
  const { toggle, clearThreePoint } = useClipTool(
    components,
    worldRef,
    threePoint,
    setClipState,
    () => setThreePoint(false),
  );

  const resetActions = useCallback(() => {
    // `highlighter.clear()` empties EVERY style, per-model tints included — and
    // a tint is a property of the file (set from the top bar, persisted across
    // reloads), not a transient selection Escape should undo. Clearing the
    // styles one by one instead would leave the tints alone but pay for a full
    // global re-paint per style, so: snapshot the tints, let the library do its
    // single-pass clear (which is also what fires the select-style events other
    // panels listen for), put the tints back, re-paint once. See model-tint.ts.
    const tinted = new Map<string, ModelIdMap>();
    for (const styleName of highlighter.styles.keys()) {
      if (isModelTintStyle(styleName)) tinted.set(styleName, highlighter.selection[styleName]);
    }
    void highlighter.clear().then(() => {
      let restored = false;
      for (const [styleName, selection] of tinted) {
        if (Object.keys(selection).length === 0) continue;
        highlighter.selection[styleName] = selection;
        restored = true;
      }
      if (restored) void highlighter.updateColors();
    });
    // The Length/Area sub-actions are disabled, so these library measurers were
    // never `setup({ world })` — calling delete()/enabled on them throws
    // "Measurement: you must specify a world first!". Guard it: Escape is now
    // also the Measure tool's "clear" gesture, so this runs on every Escape.
    try {
      lengthMeasurer.delete();
      // areaMeasurer.clear(); // Clear all area measurements
      areaMeasurer.delete();
      areaMeasurer.enabled = false;
    } catch {
      // measurers not world-bound yet — nothing to reset
    }
    if (worldRef?.current?.camera) {
      worldRef.current.camera.controls.mouseButtons.left = CameraControls.ACTION.NONE;
    }
  }, [areaMeasurer, highlighter, lengthMeasurer, worldRef]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      // In photoshoot mode Escape is the way BACK to the UI and nothing else —
      // it must not also clear the selection or the section the shot was set up
      // around, or the escape hatch would destroy the thing being photographed.
      if (photoshoot) {
        onPhotoshootChange?.(false);
        return;
      }
      // Escape also disarms 3-point section picking (the clip hook clears any
      // in-progress dots on its own Escape listener; this just un-arms the mode).
      setThreePoint(false);
      // Return to a safe default interaction state (clear selection, disable measurers).
      resetActions();
      // The measure tool owns the Highlighter's `enabled` flag while it's armed
      // (selection stays off so a pick doesn't also select) — don't stomp it
      // back on here, or Escape (which the tool uses to clear a measurement)
      // would silently re-enable selection mid-measure.
      highlighter.enabled = measureMode === null;
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [highlighter, resetActions, measureMode, photoshoot, onPhotoshootChange]);

  const viewSubActions = useMemo(
    () => [
      {
        label: "Front",
        icon: <FrontView width="16" height="16" />,
        action: () => {
          if (worldRef?.current?.camera) {
            worldRef.current.camera.controls.setLookAt(50, 0, 0, 0, 0, 0);
          }
        },
      },
      {
        label: "Back",
        icon: <BackView width="16" height="16" />,
        action: () => {
          if (worldRef?.current?.camera) {
            worldRef.current.camera.controls.setLookAt(-50, 0, 0, 0, 0, 0);
          }
        },
      },
      {
        label: "Top",
        icon: <TopView width="16" height="16" />,
        action: () => {
          if (worldRef?.current?.camera) {
            worldRef.current.camera.controls.setLookAt(0, 50, 0, 0, 0, 0);
          }
        },
      },
      {
        label: "Left",
        icon: <LeftView width="16" height="16" />,
        action: () => {
          if (worldRef?.current?.camera) {
            worldRef.current.camera.controls.setLookAt(0, 0, 50, 0, 0, 0);
          }
        },
      },
      {
        label: "Right",
        icon: <RightView width="16" height="16" />,
        action: () => {
          if (worldRef?.current?.camera) {
            worldRef.current.camera.controls.setLookAt(0, 0, -50, 0, 0, 0);
          }
        },
      },
    ],
    [worldRef],
  );

  const measureSubActions = useMemo(
    () => [
      {
        label: "Length",
        icon: <LengthMeasurementIcon width="16" height="16" />,
        action: () => {
          lengthMeasurer.enabled = true;
        },
      },
      {
        label: "Area",
        icon: <AreaMeasurementIcon width="16" height="16" />,
        action: () => {
          areaMeasurer.enabled = true;
        },
      },
    ],
    [areaMeasurer, lengthMeasurer],
  );

  const modesSubActions = useMemo(
    () => [
      {
        label: "Parallel",
        icon: <ParallelProjection width="16" height="16" />,
        action: () => {
          const w = worldRef?.current;
          if (!w?.camera || !w.scene || !w.renderer) return;
          const cam = w.camera;
          const ctr = cam.controls;

          // Switch to orthographic projection for parallel view
          cam.projection?.set?.("Orthographic");
          // Set camera to orbit mode for user interaction
          cam.set?.("Orbit");

          // Calculate optimal camera position based on scene bounds
          const box = new THREE.Box3().setFromObject(w.scene.three);
          const sphere = box.getBoundingSphere(new THREE.Sphere());
          const target = sphere.center.clone();
          const r = Math.max(sphere.radius * 2, 10);

          // Set viewing angles for isometric-like view
          const yaw = THREE.MathUtils.degToRad(45);
          const pitch = THREE.MathUtils.degToRad(35.264);

          // Calculate camera position using spherical coordinates
          const pos = new THREE.Vector3(
            target.x + r * Math.cos(yaw) * Math.cos(pitch),
            target.y + r * Math.sin(pitch),
            target.z + r * Math.sin(yaw) * Math.cos(pitch),
          );

          // Set camera up vector to Y-axis for consistent orientation
          cam.three?.up?.set(0, 1, 0);

          // Position camera to look at scene center
          ctr?.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);

          // Update camera projection matrix with new settings
          const ortho = cam.three ?? cam;
          ortho.updateProjectionMatrix?.();

          // Maintain Y-up orientation during camera movement
          keepYUpCleanupRef.current?.();
          const keepYUp = () => cam.three?.up?.set(0, 1, 0);
          ctr?.addEventListener?.("update", keepYUp);
          keepYUpCleanupRef.current = () => ctr?.removeEventListener?.("update", keepYUp);
        },
      },
      {
        label: "Perspective",
        icon: <PerspectiveView width="16" height="16" />,
        action: () => {
          const cam = worldRef?.current?.camera;
          if (!cam) return;
          cam.projection?.set?.("Perspective");
          cam.set?.("Orbit");
          if (cam.controls && "enableRotate" in cam.controls) cam.controls.enableRotate = true;
        },
      },

      /** DO NOT REMOVE THIS COMMENT, WILL USE IT LATER **/
      // {
      //   label: "Wireframe",
      //   icon: <FrontView width="16" height="16" />,
      //   action: () => {
      //     const world = worldRef?.current;
      //     if (world && world.scene) {
      //       // Toggle wireframe on all materials in the scene
      //       world.scene.three.traverse((child: any) => {
      //         if (child.material) {
      //           if (Array.isArray(child.material)) {
      //             child.material.forEach((mat: any) => {
      //               mat.wireframe = !mat.wireframe;
      //             });
      //           } else {
      //             child.material.wireframe = !child.material.wireframe;
      //           }
      //         }
      //       });
      //     }
      //   },
      // },
    ],
    [worldRef],
  );

  const actions = useMemo(
    () => [
      {
        label: "Views",
        icon: <SearchArea />,
        actionContent: viewSubActions.map(({ label, icon, action }) => (
          <SubAction
            key={label}
            label={label}
            icon={icon}
            onClick={() => {
              action?.();
            }}
          />
        )),
      },
      // Measure: pick points in the model to read a distance (2 points) or an
      // angle (3 points). "Snap" makes each pick land on the nearest model
      // corner. This is the in-house point-picking tool — the old library
      // Length/Area measurers (measureSubActions, kept below) stay disabled.
      {
        label: "Measure",
        icon: <Ruler />,
        active: measureMode !== null,
        actionContent: [
          <SubAction
            key="distance"
            label="Distance"
            icon={<LengthMeasurementIcon width="16" height="16" />}
            active={measureMode === "distance"}
            onClick={() => {
              setThreePoint(false); // measure and 3-point picking are mutually exclusive
              setMeasureMode((prev) => (prev === "distance" ? null : "distance"));
            }}
          />,
          <SubAction
            key="angle"
            label="Angle"
            icon={<AngleIcon width="16" height="16" />}
            active={measureMode === "angle"}
            onClick={() => {
              setThreePoint(false);
              setMeasureMode((prev) => (prev === "angle" ? null : "angle"));
            }}
          />,
          <SubAction
            key="snap"
            label="Snap"
            icon={<Magnet width="16" height="16" />}
            active={snapEnabled}
            onClick={() => setSnapEnabled((s) => !s)}
          />,
        ],
      },
      // Clipping: six axis planes — two per axis (bright side "a", dark
      // companion side "b") that clip OPPOSITE sides, so turning both on
      // brackets a middle slab; the pair is constrained not to pass through
      // each other while dragged. Each button is a plain on/off toggle (no
      // Ctrl, no flip). "3 Points" builds a plane through three picked points
      // (toggle again to remove it). All planes draggable along their normal.
      // Separate from Grid (a datum).
      {
        label: "Clipping",
        icon: <SectionPlane />,
        active: clipState.hasAny || threePoint,
        // Custom layout: a 2x3 grid of colour squares (row 1 = side "a", row 2 =
        // side "b"; columns XY/XZ/YZ), with the "3 Points" button to its right.
        actionContent: (
          <div className="flex items-stretch gap-2">
            <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(3, 40px)" }}>
              {(["a", "b"] as ClipSide[]).flatMap((side) =>
                (["XY", "XZ", "YZ"] as ClipAxis[]).map((axis) => {
                  const on = clipState[axis][side];
                  return (
                    <div
                      key={`${axis}:${side}`}
                      title={`${axis} clipping plane`}
                      className={`flex items-center justify-center p-1.5 rounded-lg cursor-pointer hover:bg-gradient-3 border ${
                        on
                          ? "border-bim-compliance-active-border bg-gradient-3"
                          : "border-transparent hover:border-bim-compliance-active-border"
                      }`}
                      onClick={() => {
                        setMeasureMode(null);
                        toggle(axis, side);
                      }}
                    >
                      <ClipAxisIcon axis={axis} color={PLANE_COLOR[axis][side]} active={on} width="30" height="30" />
                    </div>
                  );
                }),
              )}
            </div>
            <div
              title="3-point clipping plane — pick three points (toggle to remove)"
              className={`flex items-center justify-center px-3 rounded-lg cursor-pointer hover:bg-gradient-3 border ${
                threePoint || clipState.threePoint
                  ? "border-bim-compliance-active-border bg-gradient-3"
                  : "border-white/25 hover:border-bim-compliance-active-border"
              }`}
              onClick={() => {
                setMeasureMode(null);
                // No Clear button: a placed 3-point plane -> remove it; else
                // toggle the pick-three-points mode.
                if (clipState.threePoint) {
                  clearThreePoint();
                  setThreePoint(false);
                } else {
                  setThreePoint((p) => !p);
                }
              }}
            >
              <span className="flex flex-col items-center justify-center leading-none text-bim-compliance-text-secondary">
                <span className="text-base font-bold">3</span>
                <span className="text-[10px] font-medium mt-0.5">Point</span>
              </span>
            </div>
          </div>
        ),
      },
      // (Grid menu removed — the ground grid auto-aligns to the loaded model's
      // bottom on load/import/unmount, wired in StandaloneApp; no manual controls
      // needed for now.)
      // "Mode" (Parallel/Perspective view switching) disabled: buggy, suspended
      // until fixed. Code kept below (modesSubActions) for later re-enable.
      // {
      //   label: "Mode",
      //   icon: <Mode />,
      //   actionContent: modesSubActions.map(({ label, icon, action }) => (
      //     <SubAction
      //       key={label}
      //       label={label}
      //       icon={icon}
      //       onClick={() => {
      //         action?.();
      //       }}
      //     />
      //   )),
      // },
      {
        label: "Labels",
        icon: labelIdentifier ? <EyeShow /> : <EyeHide />,
        active: labelIdentifier !== null,
        // Hover sub-panel with two options — clicking one shows a floating
        // label with that identifier over every selected element; clicking
        // the already-active one turns labels off.
        actionContent: (
          [
            { key: "tag", label: "Tag" },
            { key: "guid", label: "GUID" },
          ] as const
        ).map(({ key, label }) => (
          <SubAction
            key={key}
            label={label}
            icon={labelIdentifier === key ? <EyeShow /> : <EyeHide />}
            active={labelIdentifier === key}
            onClick={() => setLabelIdentifier((prev) => (prev === key ? null : key))}
          />
        )),
      },
      // Photoshoot: a plain toggle, so deliberately WITHOUT `actionContent` —
      // one click has to leave a clean frame, and a hover sub-panel would be
      // one more thing to dismiss before the shot. Escape brings the UI back.
      {
        label: "Photoshoot",
        icon: <Camera />,
        active: photoshoot,
        onClick: () => onPhotoshootChange?.(!photoshoot),
      },
    ],
    [
      labelIdentifier,
      photoshoot,
      onPhotoshootChange,
      viewSubActions,
      measureMode,
      snapEnabled,
      clipState,
      threePoint,
      toggle,
      clearThreePoint,
      components,
      worldRef,
    ],
  );

  const hoveredContent = actions.find((a) => a.label === hoveredLabel)?.actionContent;

  return (
    <div
      className="absolute bottom-4 left-1/2"
      style={{ transform: `translateX(calc(-50% + ${avoidShiftPx}px))` }}
      onMouseLeave={() => setHoveredLabel(undefined)}
      ref={parentRef}
    >
      <SubPanel>
        {actions.map(({ label, icon, active, actionContent, onClick }) => {
          const resizedIcon = cloneElement(icon, { width: "25", height: "25" });

          return (
            <div
              key={label}
              className={`relative flex flex-col w-16 items-center p-2.5 gap-1 cursor-pointer hover:bg-gradient-3 rounded-lg border ${
                active ? "border-bim-compliance-active-border bg-gradient-3" : "border-transparent hover:border-bim-compliance-active-border"
              }`}
              onClick={onClick}
              onMouseEnter={(e) => {
                setHoveredLabel(label);
                if (!parentRef.current) return;
                const parentRect = parentRef.current.getBoundingClientRect();
                const childRect = e.currentTarget.getBoundingClientRect();
                const relativeX = childRect.left - parentRect.left + childRect.width / 2;
                setActionRelativeXPox(relativeX);
              }}
            >
              {/* The carrot advertises a hover sub-panel, so it's only for the
                  items that actually have one. */}
              {actionContent ? (
                <CarrotDown
                  width="8.5px"
                  height="8.5px"
                  className="absolute right-1.5 top-1.5"
                  fill={hoveredLabel === label ? "rgba(255, 255, 255, 1)" : "rgba(255, 255, 255, 0.6)"}
                  transform="rotate(225)"
                />
              ) : null}
              {resizedIcon}
              <p className="text-bim-compliance-text-secondary text-xs font-medium leading-[9px] tracking-[0]">
                {label}
              </p>
            </div>
          );
        })}
        {hoveredContent ? (
          <div className="absolute bottom-full transform -translate-x-1/2" style={{ left: `${actionRelativeXPox}px` }}>
            <SubPanel>{hoveredContent}</SubPanel>
          </div>
        ) : null}
      </SubPanel>
    </div>
  );
};

export default ControlPanel;
