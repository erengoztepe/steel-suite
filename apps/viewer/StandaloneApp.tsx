import {
  Components,
  FragmentsManager,
  IfcLoader,
  type OrthoPerspectiveCamera,
  type SimpleScene,
  type SimpleWorld,
} from "@thatopen/components";
import { Highlighter, type PostproductionRenderer } from "@thatopen/components-front";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { EyeHide, EyeShow } from "@/icons";
import { loadAppearance, saveAppearance } from "@/modules/bim-compliance/appearance-store";
import { applyBooleanBudget, type DroppedBody } from "@/modules/bim-compliance/boolean-budget";
import {
  convertIfcToFragments,
  ImportCancelledError,
  ImportStalledError,
  type ImportProgress,
} from "@/modules/bim-compliance/ifc-import-client";
import {
  baseSource,
  uniqueModelId,
  type IfcSource,
} from "@/modules/bim-compliance/ifc-sources";
import { compareWorldFrames, readWorldFrame, type IfcWorldFrame } from "@/modules/bim-compliance/ifc-world-frame";
import { loadIfcSession, saveIfcSession } from "@/modules/bim-compliance/last-ifc-store";
import { MemberVectorsPanel } from "@/modules/bim-compliance/member-vectors";
import { applyModelTints } from "@/modules/bim-compliance/model-tint";
import { PHOTOSHOOT_ATTR, setScenePhotoshoot } from "@/modules/bim-compliance/photoshoot";
import type { OrientedMemberVectorRow } from "@/modules/bim-compliance/member-vectors/types";
import { ConnectionDesignPanel } from "@/modules/bim-compliance/connection-design";
import { PlateDxfButton } from "@/modules/bim-compliance/plate-dxf";
import { applyRenderDistance } from "@/modules/bim-compliance/render-distance";
import { GIZMO_FOOTPRINT_PX, GIZMO_PANEL_GAP_PX, useAxisGizmo } from "@/modules/bim-compliance/ProjectDetail/Viewer/axis-gizmo";
import ControlPanel from "@/modules/bim-compliance/ProjectDetail/Viewer/control-panel/control-panel";
import { frameToFitWhenReady } from "@/modules/bim-compliance/ProjectDetail/Viewer/frame-to-fit";
import { alignGridWhenReady } from "@/modules/bim-compliance/ProjectDetail/Viewer/grid-datum";
import { scaleFromWidth } from "@/modules/bim-compliance/ProjectDetail/Viewer/control-panel/layout-scale";
import BackgroundSwatch from "@/modules/bim-compliance/ProjectDetail/Viewer/background-swatch";
import TintSwatch from "@/modules/bim-compliance/ProjectDetail/Viewer/tint-swatch";
import { useViewerNavigation } from "@/modules/bim-compliance/ProjectDetail/Viewer/use-viewer-navigation";
import {
  applySceneBackground,
  DEFAULT_CUSTOM_BACKGROUND,
  DEFAULT_SCENE_BACKGROUND_KEY,
  findSceneBackground,
  type CustomBackground,
} from "@/modules/bim-compliance/scene-background";
import setupViewer from "@/modules/bim-compliance/setupViewer";

// Member Vectors panel width tunables (px), at the reference width (see
// layout-scale.ts) — scaled by the live root container width below so the
// proportions validated at that reference size hold on any other monitor or
// window size.
const SELECTION_MIN_WIDTH_AT_REFERENCE = 200;
const SELECTION_DEFAULT_WIDTH_AT_REFERENCE = 300;
const SELECTION_MAX_WIDTH_AT_REFERENCE = 520;
// Results DEFAULT width is FIXED (not scaled): the results table is fixed-px
// (11px font), so the width that reveals the Alfa column — the rotation column,
// this tool's focus — is identical on every monitor. Scaling it clipped Alfa on
// smaller logical viewports. 550 px shows the table through Alfa plus a sliver of
// ey, after the panel's own px-2 padding and vertical scrollbar (Alfa's right
// edge sits ~496 px from the table's left). MIN/MAX stay scaled — they bound the
// user's own resizing, not the Alfa-reveal default.
const RESULTS_MIN_WIDTH_AT_REFERENCE = 280;
const RESULTS_DEFAULT_WIDTH_PX = 550;
const RESULTS_MAX_WIDTH_AT_REFERENCE = 1800;
// Must equal ControlPanel's own AVOID_GAP_PX_AT_REFERENCE — both derive the
// same scaled gap independently from the same shared container width, so
// this cap's arithmetic actually matches what the bar enforces visually.
const AVOID_GAP_PX_AT_REFERENCE = 80;

/**
 * Quiet time (ms) before a tint change reaches the scene — see the effect that
 * uses it. Long enough that a wheel drag collapses to a few applies, short
 * enough that a click on a preset still feels immediate.
 */
const TINT_SETTLE_MS = 140;

/**
 * Widest a right-anchored panel may grow, given that the bottom control bar
 * slides left out of its way once the panel gets within the gap, and that the
 * bar itself must stop with the same gap held clear of whatever sits
 * bottom-left — the axis gizmo, which itself always trails the left
 * Connection Library panel by its own fixed gap, so the gizmo's right edge is
 * always the furthest-right point on that side.
 *
 * So the travel is a chain of three, in two stages:
 *   1. the panel widens ALONE while the bar still has its natural gap;
 *   2. from there the two move in lockstep — panel widens, bar slides left —
 *      until the bar reaches its own stop. That's this cap:
 *
 *     bar's left edge (in lockstep) = rootWidth − panelWidth − gap − barWidth
 *     requiring  barLeft ≥ leftObstacleRight + gap  gives
 *     panelWidth ≤ rootWidth − barWidth − 2·gap − leftObstacleRight
 *
 * Returns the ceiling untouched until the bar's own width is known.
 */
function maxWidthBeforeControlBarRunsOut({
  rootWidth,
  controlBarWidth,
  leftObstacleRightPx,
  gapPx,
  ceiling,
  floor,
}: {
  rootWidth: number;
  controlBarWidth: number;
  leftObstacleRightPx: number;
  gapPx: number;
  ceiling: number;
  floor: number;
}): number {
  if (controlBarWidth <= 0 || rootWidth <= 0) return ceiling;
  const barOutOfTravel = rootWidth - controlBarWidth - 2 * gapPx - leftObstacleRightPx;
  // Never below the panel's own minimum — on a window too narrow to honor the
  // gaps at all, a usable panel wins over the gap arithmetic, and the bar's own
  // clamp keeps it off the gizmo regardless.
  return Math.max(floor, Math.min(ceiling, barOutOfTravel));
}

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

// Auto-loaded on first launch so there's always a model in view. The file is local-only
// (git-ignored): drop any IFC at apps/viewer/public/models/default.ifc. Without one the viewer
// simply starts empty.
const DEFAULT_IFC_URL = "/models/default.ifc";
const DEFAULT_IFC_NAME = "default.ifc";

/** What an import turned out to be, surfaced in the notice box afterwards. */
interface ImportReport {
  fileName: string;
  /**
   * Elements that were already in the viewer from another file, by GlobalId.
   * They are loaded anyway (the user's call): overlapping parts are drawn twice
   * and clicking one is ambiguous, so the count is reported rather than hidden.
   */
  clashCount: number;
  /**
   * Set only when the imported file places its structure in a different world
   * frame than the base file — see `ifc-world-frame.ts`. Cross-file joints are
   * not trustworthy in that state, so this is a warning, not a statistic.
   */
  frameMismatch: { originDeltaMm: number; rotationDiffers: boolean } | null;
}

/**
 * Bodies the gate check refused before conversion, per file (see
 * `boolean-budget.ts`). Reported for EVERY load, including a session restore:
 * the alternative is a model quietly missing an element, which is the failure
 * mode this whole mechanism exists to avoid trading a hang for.
 */
interface GeometryReport {
  fileName: string;
  dropped: DroppedBody[];
}

/**
 * GlobalIds of a model's PHYSICAL elements — the ones that carry geometry.
 *
 * Deliberately not `model.getGuids()`: two files cut from one structure always
 * share their spatial and organisational entities (IfcProject, IfcSite,
 * IfcBuilding, IfcElementAssembly, and every relationship and property set
 * hanging off them) — those are containers the parts have in common by
 * construction, not elements that got duplicated.
 * Counting them made a cleanly-split pair — disjoint beams, disjoint plates —
 * report 22 overlaps, which is noise that would fire on every legitimate import.
 * Having geometry is what separates "an element is in both files" from "both
 * files describe the same building": containers carry none, members and bolts do.
 */
async function physicalGuids(model: { getItemsIdsWithGeometry: () => Promise<number[]>; getGuidsByLocalIds: (ids: number[]) => Promise<(string | null)[]> }): Promise<string[]> {
  const localIds = await model.getItemsIdsWithGeometry();
  const guids = await model.getGuidsByLocalIds(localIds);
  return guids.filter((g): g is string => !!g);
}

/** Where the vendored, offline web-ifc WASM lives — shared by the main-thread
 *  loader setup and the conversion worker so both resolve the same files. */
const WEB_IFC_WASM = { path: "/wasm/web-ifc/", absolute: true } as const;

/** A conversion in flight, as shown in the top bar. */
interface LoadProgress {
  fileName: string;
  /** 0..1, or null before the importer has reported anything. */
  value: number | null;
  /** The importer's current stage, translated for the bar. */
  stage: string;
}

const STAGE_LABEL: Record<string, string> = {
  geometries: "geometry",
  attributes: "attributes",
  relations: "relations",
  conversion: "conversion",
};

/** Physical-element GlobalIds currently in the viewer, across all loaded models. */
async function loadedGuids(fragmentsManager: FragmentsManager): Promise<Set<string>> {
  const out = new Set<string>();
  for (const model of fragmentsManager.list.values()) {
    try {
      for (const guid of await physicalGuids(model as any)) out.add(guid);
    } catch {
      // A model that can't answer contributes nothing — an unreported overlap
      // is a lesser problem than a failed import.
    }
  }
  return out;
}

/**
 * Self-contained Member Vectors tool: load any IFC (drag-drop or picker),
 * fully client-side (web-ifc WASM + fragments worker vendored locally), no
 * backend, no auth. Mounts only the viewer control panel + the Member Vectors
 * panel (always open).
 */
export default function StandaloneApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const components = useMemo(() => new Components(), []);
  const ifcLoader = useMemo(() => components.get(IfcLoader), [components]);
  const fragmentsManager = useMemo(() => components.get(FragmentsManager), [components]);

  // Every IFC currently loaded, base file first — one entry per file, each
  // holding the raw bytes its members must be extracted from. The ref is the
  // authoritative copy (a load mutates it and reads it back mid-async, where a
  // state value would still be the pre-update one); `sources` mirrors it purely
  // so the UI re-renders. Always write both through `publishSources`.
  const sourcesRef = useRef<IfcSource[]>([]);
  const [sources, setSources] = useState<IfcSource[]>([]);
  const publishSources = useCallback((next: IfcSource[]) => {
    sourcesRef.current = next;
    setSources(next);
  }, []);
  const getIfcSources = useCallback(() => sourcesRef.current, []);
  // modelIds currently hidden via `toggleSourceVisibility` — UI-only, so a
  // reload always comes back with everything shown (see that function for why
  // this is deliberately not part of the persisted session).
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<string>>(new Set());
  // Ref mirror, same reason `sourcesRef` mirrors `sources`: `useViewerNavigation`
  // reads this from inside native DOM event handlers set up once per mount,
  // where a captured `useState` value would go stale the moment the user hides
  // a second file.
  const hiddenModelIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    hiddenModelIdsRef.current = hiddenModelIds;
  }, [hiddenModelIds]);
  // Memoized so it only changes when the file set really does — it's an effect
  // dependency in the panel, and a fresh array every render would re-run that
  // reconciliation on every keystroke.
  const loadedModelIds = useMemo(() => sources.map((s) => s.modelId), [sources]);
  // Appearance: which tone each FILE is painted in, and the colour of the space
  // behind the model. Read synchronously on first render so the chosen
  // background is the first thing painted (see appearance-store.ts), and keyed
  // by file name for the same reason the store is.
  const [tintByFileName, setTintByFileName] = useState<Record<string, string>>(
    () => loadAppearance().tints ?? {},
  );
  const [backgroundKey, setBackgroundKey] = useState<string>(
    () => loadAppearance().background ?? DEFAULT_SCENE_BACKGROUND_KEY,
  );
  // The two stops behind the "Custom" background. Kept while a preset is
  // selected, so switching back to Custom returns to the mix the user made.
  const [customBackground, setCustomBackground] = useState<CustomBackground>(
    () => loadAppearance().customBackground ?? DEFAULT_CUSTOM_BACKGROUND,
  );
  // The tint layer wants modelIds (that's what the highlighter keys on) while
  // the user's choice is stored per file name — one place to cross the two, so
  // an unmounted file simply drops out and a re-imported one comes back tinted.
  const tintAssignment = useMemo(() => {
    const byModel = new Map<string, string>();
    for (const s of sources) {
      const key = tintByFileName[s.fileName];
      if (key) byModel.set(s.modelId, key);
    }
    return byModel;
  }, [sources, tintByFileName]);
  // Base file's world frame, read lazily on the first import and kept until the
  // base is replaced — reading it costs a full web-ifc parse of a file that can
  // be tens of MB, so the single-file path (which has nothing to compare
  // against) must never pay for it.
  const baseFrameRef = useRef<IfcWorldFrame | null>(null);
  // Every modelId issued in this page session, including ones since unmounted.
  // Grows only — see `uniqueModelId` for why a freed id must never come back.
  const usedModelIdsRef = useRef<Set<string>>(new Set());

  const [ready, setReady] = useState(false);
  // We hold a ref to the loaded connection fragments model UUID to properly clear it when hidden.
  const connectionModelIdRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  // One entry per loaded file that lost geometry at the gate. Accumulates with
  // imports and is cleared by a replacing load, mirroring `sources`.
  const [geometryReports, setGeometryReports] = useState<GeometryReport[]>([]);
  // Live conversion progress, non-null exactly while a worker is running.
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);
  // Aborts the conversion in flight. Held in a ref because the cancel button
  // and the watchdog both reach for it from outside the load's own closure.
  const abortRef = useRef<AbortController | null>(null);
  // A load already running. Now that the UI stays responsive during a
  // conversion, the buttons are genuinely clickable mid-load — and a second
  // "replace" load disposes the models the first one is still loading into,
  // which surfaces as "Fragments: Model not found". One at a time.
  const loadingRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  // Photoshoot mode: model only, everything else hidden (see photoshoot.ts).
  // Owned here rather than in ControlPanel — the bar offers the button, but the
  // mode hides this component's own chrome and gates the axis gizmo.
  const [photoshoot, setPhotoshoot] = useState(false);
  // Which authoring tool exported the current IFC — shared between the Member
  // Vectors panel (extraction fallback behavior) and the viewer ControlPanel
  // (floating label content: GlobalId vs Tag), so it's owned here rather than
  // by either sibling.
  const [ifcSource, setIfcSource] = useState<"tekla" | "autodesk">("autodesk");
  // Live width (px) of the Member Vectors right panel — reported by the panel
  // itself as it's resized, so ControlPanel (the bottom Views/Labels bar) can
  // shift out of its way instead of the two overlapping.
  const [memberVectorsPanelWidth, setMemberVectorsPanelWidth] = useState<number | null>(null);
  // Live width (px) of the left Connection Library panel — reported the same
  // way. It's what the bottom bar's leftward avoid-slide has to stop short of
  // once it's wider than the axis gizmo it covers.
  const [libraryPanelWidth, setLibraryPanelWidth] = useState(0);
  // Live width (px) of the ControlPanel bar itself — reported the same way —
  // needed (alongside the root container's width) to cap how wide the results
  // panel is allowed to grow, so it can never crowd out both the bar's
  // 80px-from-panel gap AND the bar's 80px-from-viewport-edge gap at once.
  const [controlBarWidth, setControlBarWidth] = useState(0);
  // State for the Member Vectors Panel
  const [memberVectorsRightPanelOpen, setMemberVectorsRightPanelOpen] = useState(true);
  // State for the Connection Design Panel
  const [connectionDesignPanelOpen, setConnectionDesignPanelOpen] = useState(false);
  const [connectionDesignPanelWidth, setConnectionDesignPanelWidth] = useState(0);
  const [connectionDesignMemberRows, setConnectionDesignMemberRows] = useState<OrientedMemberVectorRow[]>([]);
  const [connectionDesignIomXml, setConnectionDesignIomXml] = useState<string | null>(null);
  const [connectionDesignNodeMm, setConnectionDesignNodeMm] = useState<[number, number, number] | null>(null);

  // Height (px) of the top bar, published to the side panels as the
  // --viewer-top-inset CSS variable below. The bar is painted above them
  // (higher z-index), so without this inset it covers each panel's header row
  // — the title, the collapse chevron and the close button all disappear
  // behind it. Measured rather than hard-coded so it survives font-size,
  // zoom and wrapping changes.
  const topBarRef = useRef<HTMLDivElement>(null);
  const [topBarHeight, setTopBarHeight] = useState(0);
  useLayoutEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const update = () => setTopBarHeight(el.getBoundingClientRect().height);
    // Measured before first paint, then re-measured on the two things that
    // change the bar's height after mount: a webfont swapping in (the first
    // measurement can land on fallback-font metrics) and a viewport resize
    // narrow enough to reflow the bar's contents.
    update();
    void document.fonts?.ready.then(update).catch(() => undefined);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, []);
  // Width of the shared root container both the panel and the bar are
  // absolutely positioned within — the basis for that same cap.
  const [rootWidth, setRootWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setRootWidth(el.getBoundingClientRect().width);
    update();
    // Belt-and-suspenders: a window "resize" listener alongside the
    // ResizeObserver — some viewport-resize paths (e.g. certain embedding or
    // automated-testing contexts) change layout without reliably scheduling
    // a ResizeObserver callback, but always fire a native resize event.
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, []);
  // All Member Vectors panel-sizing tunables, scaled off the live root
  // container width so they keep the same on-screen proportions on any
  // monitor or window size, not just the reference one they were tuned on.
  const layoutScale = scaleFromWidth(rootWidth);
  const selectionMinWidth = Math.round(SELECTION_MIN_WIDTH_AT_REFERENCE * layoutScale);
  const selectionDefaultWidth = Math.round(SELECTION_DEFAULT_WIDTH_AT_REFERENCE * layoutScale);
  const selectionMaxCeiling = Math.round(SELECTION_MAX_WIDTH_AT_REFERENCE * layoutScale);
  const resultsMinWidth = Math.round(RESULTS_MIN_WIDTH_AT_REFERENCE * layoutScale);
  const resultsDefaultWidth = RESULTS_DEFAULT_WIDTH_PX; // fixed — see constant note
  const resultsMaxCeiling = Math.round(RESULTS_MAX_WIDTH_AT_REFERENCE * layoutScale);
  const scaledAvoidGapPx = AVOID_GAP_PX_AT_REFERENCE * layoutScale;
  // The gizmo always trails the left Connection Library panel by a fixed gap
  // (see axis-gizmo.ts), so it — never the panel itself — is the thing
  // furthest right on this side, at any panel width or collapse state.
  const gizmoLeftPx = libraryPanelWidth + GIZMO_PANEL_GAP_PX;
  const leftObstacleRightPx = gizmoLeftPx + GIZMO_FOOTPRINT_PX;
  // Both screens' widest setting is where the bar, having slid left in lockstep
  // with the panel, runs out of its own travel — so the panel widens alone
  // first, then the two move together, and everything still holds its gap. No
  // overlap at any point in the chain.
  const selectionMaxWidth = maxWidthBeforeControlBarRunsOut({
    rootWidth,
    controlBarWidth,
    leftObstacleRightPx,
    gapPx: scaledAvoidGapPx,
    ceiling: selectionMaxCeiling,
    floor: selectionMinWidth,
  });
  const resultsPanelMaxWidth = maxWidthBeforeControlBarRunsOut({
    rootWidth,
    controlBarWidth,
    leftObstacleRightPx,
    gapPx: scaledAvoidGapPx,
    ceiling: resultsMaxCeiling,
    floor: resultsMinWidth,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!viewerRef.current) return;
      const world = await setupViewer({ viewerRef, components });
      if (cancelled) return;
      worldRef.current = world;
      // Local, offline web-ifc WASM (vendored under public/wasm/web-ifc/).
      // The conversion worker is pointed at the same files; `IfcLoader` itself
      // no longer converts anything, but the panel's own extractors run web-ifc
      // on this thread and rely on this setup having happened.
      await ifcLoader.setup({ autoSetWasm: false, wasm: { ...WEB_IFC_WASM } });
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [components, ifcLoader]);

  useViewerNavigation(components, worldRef, ready, hiddenModelIdsRef);
  // The gizmo draws itself straight onto the main canvas each frame, so it is
  // beyond the reach of the CSS that hides the DOM chrome — gate its effect
  // instead. Tearing the little arrow scene down and rebuilding it on toggle is
  // cheaper than carrying a visibility flag through the draw loop.
  useAxisGizmo(worldRef, ready && !photoshoot, gizmoLeftPx);

  // Keep the ground grid at the foot of whatever is loaded. The grid ThatOpen
  // creates sits at world Y=0, which has no relation to where a given IFC's
  // geometry actually lands — so importing a roof model and then the structure below it
  // used to leave the grid stranded between the two. Re-run on every change to
  // the loaded/visible set (load, import, unmount, source-visibility toggle);
  // `loadedModelIds`/`hiddenModelIds` are the declarative signals for exactly
  // those events. `alignGridToModels` measures the models only (never the scene,
  // which holds the grid itself) and no-ops when there is nothing to align to.
  useEffect(() => {
    if (!ready) return undefined;
    // Re-snaps a few times over ~2.5 s so it catches the fragment tiles that
    // stream in after the model set changes (a single immediate align sees an
    // empty box and no-ops). Cancelled if the set changes again first.
    // Keyed on `loadedModelIds` only — so it fires on load / import / unmount,
    // but NOT on a hide/unhide (visibility is a view convenience, not a reason
    // to move the ground datum).
    return alignGridWhenReady(components, worldRef.current);
  }, [ready, components, loadedModelIds]);

  // Draw distance: the far plane derived from what is loaded, and fragments' LOD
  // box placeholders turned off. Declared BEFORE the tint effect on purpose —
  // effects run in order, and a tint applied while the placeholders are still
  // live is drawn by geometry the tint never reaches (see render-distance.ts).
  // Re-run on the same signal as the grid datum: the placeholders and the far
  // plane are both properties of the loaded set.
  useEffect(() => {
    if (!ready) return undefined;
    // Same reason the grid datum re-snaps on a schedule: the combined box the
    // far plane is derived from fills in as fragment tiles stream, so a single
    // pass at load time measures an empty box and settles on the floor value.
    const timers = [0, 400, 1500].map((delay) =>
      window.setTimeout(() => applyRenderDistance(components, worldRef.current), delay),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [ready, components, loadedModelIds]);

  // Space colour. The canvas is transparent (see scene-background.ts), so this
  // paints the container behind it and re-colours the grid to match.
  useEffect(() => {
    if (!ready) return;
    applySceneBackground(
      components,
      viewerRef.current,
      findSceneBackground(backgroundKey, customBackground),
    );
    // On-demand renderer: a new grid colour is not a camera move, so nothing
    // would otherwise ask for a repaint.
    const renderer = worldRef.current?.renderer;
    if (renderer) renderer.needsUpdate = true;
  }, [ready, components, backgroundKey, customBackground]);

  // Per-model tint. Keyed on the derived assignment, so this one effect covers
  // a colour change, a load, an import AND an unmount — the same declarative
  // shape as the grid datum above, and for the same reason: no event can be
  // missed if the trigger is the state itself.
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    void (async () => {
      // Settle first. Dragging the colour wheel emits a colour per pointer
      // move, and one apply is a global re-highlight plus a tile re-stream —
      // AND leaves a material behind per distinct colour, since the library
      // pools them. So the 3D follows the drag at the rate a person can see
      // rather than at the rate the pointer reports. The delay is invisible on
      // the paths that are not a drag (load, import, unmount, one click on a
      // preset).
      await new Promise((r) => setTimeout(r, TINT_SETTLE_MS));
      if (cancelled) return;
      // Then re-apply on a short schedule (the `alignGridWhenReady` pattern):
      // fragment tiles stream in after a load resolves, so a tint applied the
      // instant a model is published can land before its meshes exist. Each
      // pass re-asserts the same assignment, so the last one wins and the
      // earlier ones are harmless if the geometry was already there.
      for (const delay of [0, 300, 1200]) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        await applyModelTints(components, tintAssignment);
        if (cancelled) return;
        const renderer = worldRef.current?.renderer;
        if (renderer) renderer.needsUpdate = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, components, tintAssignment]);

  useEffect(() => {
    saveAppearance({ background: backgroundKey, customBackground, tints: tintByFileName });
  }, [backgroundKey, customBackground, tintByFileName]);

  // Scene side of photoshoot mode. Deliberately NOT persisted: it is a shutter,
  // not a preference — coming back to a viewer with no UI would look broken.
  useEffect(() => {
    if (!ready) return undefined;
    setScenePhotoshoot(components, worldRef.current, photoshoot);
    // Restore on unmount too, so a hot reload mid-shoot can't leave the scene
    // objects hidden with the snapshot gone.
    return () => setScenePhotoshoot(components, worldRef.current, false);
  }, [ready, components, photoshoot]);

  // The hint is the only way out of a UI-less screen that is discoverable, and
  // also the only thing in the frame that is not the model — so it shows itself
  // briefly and then gets out of the way.
  const [showPhotoshootHint, setShowPhotoshootHint] = useState(false);
  useEffect(() => {
    if (!photoshoot) {
      setShowPhotoshootHint(false);
      return undefined;
    }
    setShowPhotoshootHint(true);
    const timer = window.setTimeout(() => setShowPhotoshootHint(false), 2200);
    return () => window.clearTimeout(timer);
  }, [photoshoot]);

  /**
   * Put an IFC in the viewer, either REPLACING everything loaded ("Load IFC",
   * and the drop target) or ADDING alongside it ("Import IFC") so a structure
   * delivered as several files can be assembled into one model.
   *
   * `report` drives the post-import notice box; it's off for a session restore,
   * which re-runs the same additive path but has nothing new to tell the user
   * (and would otherwise re-pay the world-frame parse on every launch).
   */
  const loadIfcBuffer = useCallback(
    async (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { persist?: boolean; mode?: "replace" | "add"; report?: boolean },
    ) => {
      const mode = options?.mode ?? "replace";
      const report = options?.report ?? mode === "add";
      // See `loadingRef`: overlapping loads corrupt each other's model set.
      if (loadingRef.current) {
        setError("A load is already in progress — wait for it to finish or cancel it.");
        return;
      }
      loadingRef.current = true;
      const abort = new AbortController();
      abortRef.current = abort;
      setError(null);
      setLoading(true);
      setLoadProgress({ fileName, value: null, stage: "preparing" });
      try {
        const world = worldRef.current;

        // Never the bare file name if that name was ever used in this session —
        // see `uniqueModelId`: stale `modelId:localId` caches outlive a model, so
        // recycling an id makes them answer for the wrong file.
        const modelId = uniqueModelId(usedModelIdsRef.current, fileName);
        usedModelIdsRef.current.add(modelId);

        // Refuse unconvertible bodies BEFORE web-ifc is asked to evaluate them —
        // a deep boolean chain does not finish, and the call is synchronous, so
        // there is nothing to time out once it has started. Returns the input
        // buffer itself when nothing is over budget, so a file that already
        // loads is provably not rewritten.
        const gated = applyBooleanBudget(buffer);

        // NOTHING is torn down until the conversion has actually produced
        // fragments. A cancel or a failure has to leave the viewer exactly as it
        // was — disposing first (as this did while the conversion was
        // uninterruptible and so could not be abandoned) means an abandoned load
        // empties the viewer, which is a worse outcome than the load itself
        // failing.
        // Conversion runs in a worker; only the handoff to the scene is done
        // here. `autoCoordinate` is what `IfcLoader.load(bytes, true, …)` used
        // to set for us — it seats each model against the first one loaded, so
        // imported parts land on the base file instead of at their own origins.
        fragmentsManager.core.settings.autoCoordinate = true;
        const fragmentBytes = await convertIfcToFragments(
          // A copy: the worker transfers what it is given, and the ORIGINAL
          // buffer has to survive for the extractors. (When the gate rewrote the
          // file, `gated.bytes` is already a private copy — but not always, so
          // copy unconditionally rather than depend on which branch ran.)
          gated.bytes.slice(0),
          {
            wasmPath: WEB_IFC_WASM.path,
            wasmAbsolute: WEB_IFC_WASM.absolute,
            signal: abort.signal,
            onProgress: (p: ImportProgress) =>
              setLoadProgress({
                fileName,
                value: p.value,
                stage: STAGE_LABEL[p.process] ?? p.process,
              }),
          },
        );

        // --- past this line the load is committed; no more awaiting the user ---

        if (mode === "replace") {
          // Loading is additive, so a REPLACING load has to dispose what's
          // already there or it keeps sitting in the scene and skews
          // frameToFit's bounding box against the new model. Importing depends
          // on that same additivity — it just skips this block.
          for (const [id, loaded] of fragmentsManager.list) {
            world?.scene.three.remove(loaded.object);
            await fragmentsManager.core.disposeModel(id);
          }
          world?.meshes.clear();
          publishSources([]);
          baseFrameRef.current = null;
          setImportReport(null);
          setGeometryReports([]);
          setHiddenModelIds(new Set());
        }

        // Captured BEFORE the incoming model joins the list, so the overlap is
        // measured against the OTHER files only.
        const guidsBefore = report ? await loadedGuids(fragmentsManager) : null;

        const model = await fragmentsManager.core.load(fragmentBytes, { modelId });

        // Set only now: a load that never committed must not leave a notice
        // about geometry it dropped from a model that was never shown.
        if (gated.dropped.length > 0) {
          setGeometryReports((prev) => [
            ...prev.filter((r) => r.fileName !== fileName),
            { fileName, dropped: gated.dropped },
          ]);
        }

        // The ORIGINAL bytes, never the gated ones: every extractor re-opens
        // this buffer in its own web-ifc model (see `ifc-sources.ts`), and it
        // must see the file as delivered. Only the viewer's geometry is gated.
        const next: IfcSource[] = [
          ...sourcesRef.current,
          { modelId, fileName, buffer, isBase: sourcesRef.current.length === 0 },
        ];
        publishSources(next);

        if (report) {
          const guids = await physicalGuids(model as any).catch(() => [] as string[]);
          const clashCount = guids.filter((g) => guidsBefore?.has(g)).length;

          // Do the frames agree? Only meaningful against a DIFFERENT base file.
          let frameMismatch: ImportReport["frameMismatch"] = null;
          const base = next[0];
          if (base && base.modelId !== modelId) {
            try {
              baseFrameRef.current ??= await readWorldFrame(new Uint8Array(base.buffer));
              const comparison = compareWorldFrames(
                baseFrameRef.current,
                await readWorldFrame(new Uint8Array(buffer)),
              );
              if (!comparison.matches) {
                frameMismatch = {
                  originDeltaMm: comparison.originDeltaMm,
                  rotationDiffers: comparison.rotationDiffers,
                };
              }
            } catch {
              // An unreadable frame is not a reason to refuse the import; the
              // file is already in the scene and usable within itself.
            }
          }
          setImportReport({ fileName, clashCount, frameMismatch });
        }

        // Frame the model and cap max zoom-out relative to its size. After an
        // import this fits the combined extent, which is the point — it shows
        // the user straight away whether the parts landed on top of each other.
        // `WhenReady` because the geometry is still streaming in at this point
        // (see frame-to-fit.ts); a single fit here measures an almost-empty model.
        if (world) frameToFitWhenReady(world);
        // Remember the whole set so the next launch reopens all of it instead of
        // the bundled default. Fire-and-forget — a persistence failure (e.g. a
        // private-browsing tab with IndexedDB disabled) shouldn't block the
        // viewer from working.
        if (options?.persist ?? true) {
          void saveIfcSession(next.map((s) => ({ name: s.fileName, buffer: s.buffer }))).catch(() => undefined);
        }
      } catch (e) {
        // Cancelling is a choice, not a failure — say so plainly instead of
        // leaving an error the user has to interpret.
        if (e instanceof ImportCancelledError) {
          setError(`${fileName}: load cancelled.`);
        } else if (e instanceof ImportStalledError) {
          // The whole point of the backstop: name what happened and what to do,
          // rather than leave the user guessing at a spinner that never ends.
          setError(
            `${fileName}: conversion stalled (no progress for ${Math.round(e.stalledForMs / 1000)} s` +
              `${e.lastProgress ? `, last stage: ${STAGE_LABEL[e.lastProgress.process] ?? e.lastProgress.process}` : ""}). ` +
              `Likely cause: an element's body is too complex to draw and fell below the boolean threshold. ` +
              `Load stopped; the previous model was kept.`,
          );
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        loadingRef.current = false;
        abortRef.current = null;
        setLoading(false);
        setLoadProgress(null);
      }
    },
    [fragmentsManager, publishSources],
  );

  const loadIfc = useCallback(
    async (file: File, mode: "replace" | "add" = "replace") => {
      if (!file.name.toLowerCase().endsWith(".ifc")) {
        setError("Please choose an .ifc file.");
        return;
      }
      await loadIfcBuffer(await file.arrayBuffer(), file.name, { mode });
    },
    [loadIfcBuffer],
  );

  /**
   * Take one IMPORTED file back out without reloading the app.
   *
   * The base file is deliberately not unmountable: it is the coordination base
   * every other model was aligned to (`autoCoordinate` seats each import against
   * the first model's frame) and the key the Connection Library is stored under.
   * Removing it would leave the remaining models seated against a frame that is
   * gone and silently move the library to a different file.
   *
   * Anything downstream holding this model's ids has to let go of them too —
   * that's what publishing the reduced registry is for; the Member Vectors panel
   * purges against it (see its `loadedModelIds` effect). A leftover reference
   * doesn't fail loudly here: an extraction routed at a missing buffer returns
   * NOTHING for that member and the member just disappears from the result.
   */
  const unmountSource = useCallback(
    async (modelId: string) => {
      const source = sourcesRef.current.find((s) => s.modelId === modelId);
      if (!source || source.isBase) return;
      setError(null);
      try {
        const world = worldRef.current;
        const model = fragmentsManager.list.get(modelId);
        if (model) {
          // Mirror of setupViewer's `list.onItemSet`, which is what puts a model
          // in the scene (`world.scene.three.add(model.object)`).
          //
          // Deliberately NOT touching `world.meshes`: the only code that would
          // fill it hangs on `fragmentsManager.onFragmentsLoaded`, an event this
          // version of @thatopen/components constructs but never triggers — so
          // the set is empty and per-model mesh bookkeeping here would be dead
          // code pretending to be load-bearing. (And `world.meshes.clear()`,
          // which the replacing load calls, would be outright wrong here: it
          // would strip the models that stay.)
          world?.scene.three.remove(model.object);
          await fragmentsManager.core.disposeModel(modelId);
          await fragmentsManager.core.update(true);
          // The PostproductionRenderer paints on demand. Removing geometry moves
          // no camera, so without this flag the unmounted model stays on screen
          // until the user next pans or zooms — same reason
          // `clearStoreyIsolation` sets it after un-hiding.
          if (world?.renderer) world.renderer.needsUpdate = true;
        }

        const next = sourcesRef.current.filter((s) => s.modelId !== modelId);
        publishSources(next);
        // The notice boxes describe an import that is no longer loaded.
        setImportReport((prev) => (prev?.fileName === source.fileName ? null : prev));
        setGeometryReports((prev) => prev.filter((r) => r.fileName !== source.fileName));
        // A freed modelId is never reused (`uniqueModelId`), so this is tidiness
        // rather than a correctness fix, but a stale id sitting in the set would
        // be a trap for the next person reading it.
        setHiddenModelIds((prev) => {
          if (!prev.has(modelId)) return prev;
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
        // Deliberately NO frameToFit: taking a file back out is not a request to
        // move the camera, and re-framing while an Extract & Isolate is active
        // would fight the isolated view the user is working in.
        void saveIfcSession(next.map((s) => ({ name: s.fileName, buffer: s.buffer }))).catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [fragmentsManager, publishSources],
  );

  /**
   * Show/hide a loaded file WITHOUT unmounting it — the fragments buffer, the
   * extraction registry entry and the Connection Library association all stay
   * exactly as they are; only what the renderer draws changes.
   *
   * `model.object.visible` is the lever, not `model.setVisible(ids, false)`.
   * The latter is fragments' own PER-ITEM visibility bookkeeping — the one
   * `applyStoreyIsolation`/`clearStoreyIsolation` and Extract & Isolate already
   * drive — and `clearStoreyIsolation` calls `model.resetVisible()` on every
   * loaded model unconditionally. Piggy-backing this toggle on that same
   * mechanism would make closing an isolation silently un-hide a file the user
   * hid on purpose. `object.visible` is the native three.js flag on the root
   * the renderer already skips wholesale, so it composes cleanly underneath
   * whatever per-item state that other system is tracking.
   *
   * Deliberately session-only (not written into `saveIfcSession`): this is a
   * view convenience, not project state, and the existing persistence only
   * ever carried WHICH files are loaded, never how they're displayed.
   */
  const toggleSourceVisibility = useCallback(
    (modelId: string) => {
      const model = fragmentsManager.list.get(modelId);
      if (!model) return;
      const nextVisible = !model.object.visible;
      model.object.visible = nextVisible;
      // On-demand renderer: flipping a flag on already-loaded geometry moves no
      // camera and fires no event that would otherwise trigger a repaint.
      const renderer = worldRef.current?.renderer;
      if (renderer) renderer.needsUpdate = true;
      setHiddenModelIds((prev) => {
        const next = new Set(prev);
        if (nextVisible) next.delete(modelId);
        else next.add(modelId);
        return next;
      });
    },
    [fragmentsManager],
  );

  const handleLoadConnectionIfc = useCallback(
    async (buffer: ArrayBuffer, nodeMm: [number, number, number]) => {
      const world = worldRef.current;
      if (!world) return;
      try {
        console.log("handleLoadConnectionIfc called with buffer length:", buffer.byteLength, "nodeMm:", nodeMm);
        
        // Remove previous mock if it exists (for the old THREE.Mesh box approach)
        const prevMock = world.scene.three.getObjectByName("mock_connection");
        if (prevMock) {
          world.scene.three.remove(prevMock);
          console.log("Removed previous mock connection");
        }

        // Dispose of previously loaded connection fragments (both real and mock)
        if (connectionModelIdRef.current) {
          const existingModel = fragmentsManager.list.get(connectionModelIdRef.current);
          if (existingModel) {
            world.scene.three.remove(existingModel.object);
            await fragmentsManager.core.disposeModel(connectionModelIdRef.current);
            console.log("Disposed of previous connection IFC model:", connectionModelIdRef.current);
          }
          connectionModelIdRef.current = null;
        }
        
        // 0-byte buffer is our signal to CLEAR the connection from the scene
        if (buffer.byteLength === 0) {
          world.camera.controls.dispatchEvent({ type: "control" });
          return;
        }

        const redMaterial = new THREE.MeshStandardMaterial({
          color: 0xff0000,
          roughness: 0.2,
          metalness: 0.1,
          side: THREE.DoubleSide,
        });

        // 1-byte buffer is our signal that the API is disconnected and we should mock it
        let finalBuffer = buffer;
        let isMock = false;
        if (buffer.byteLength === 1) {
          console.log("Mocking IFC load by fetching a real IFC to prove ifcLoader works...");
          const res = await fetch("/models/mock_connection.ifc");
          finalBuffer = await res.arrayBuffer();
          isMock = true;
        }

        // Load the connection IFC additively (without clearing fragmentsManager).
        const model = await ifcLoader.load(new Uint8Array(finalBuffer), true, isMock ? "mock_connection.ifc" : "connection.ifc");
        for (const [id, m] of fragmentsManager.list) {
          if (m === model) connectionModelIdRef.current = id;
        }
        
        // In thatopen v3, the FragmentsGroup is a logical container, but the actual 
        // InstancedMeshes are in model.items[i].mesh and are added to world.meshes.
        // IDEA StatiCa exports the IFC with the connection node at the origin (0,0,0).
        // We must translate the imported meshes to match the original location.
        const dx = nodeMm[0] / 1000;
        const dy = nodeMm[1] / 1000;
        const dz = nodeMm[2] / 1000;
        
        // Translate the model group as well just to be consistent
        const modelGroup = model as any;
        modelGroup.position.set(dx, dy, dz);
        modelGroup.updateMatrixWorld(true);

        const highlighter = components.get(Highlighter);
        const forceVisible = (highlighter as any).isSetup && (highlighter as any).styles.has("select");

        // Highlight the imported connection model in red, translate meshes, and make visible
        (model as any).items?.forEach((fragment: any) => {
          const child = fragment.mesh;
          if (child) {
            // Apply translation
            child.position.set(dx, dy, dz);
            child.updateMatrixWorld(true);
            
            // Apply red material
            child.material = Array.isArray(child.material)
              ? child.material.map(() => redMaterial)
              : redMaterial;
              
            // Ensure visibility if isolation is active
            if (forceVisible) {
              child.visible = true;
            }
          }
        });
        
        // Zoom to the connection using manual Box3 calculation
        if (world.camera.hasCameraControls()) {
          const box = new THREE.Box3();
          const mat = new THREE.Matrix4();
          
          (model as any).items?.forEach((fragment: any) => {
            const child = fragment.mesh;
            if (child && (child.isInstancedMesh || child.isMesh)) {
              if (child.geometry && !child.geometry.boundingBox) {
                child.geometry.computeBoundingBox();
              }
              const geomBox = child.geometry.boundingBox;
              if (geomBox) {
                if (child.isInstancedMesh) {
                  for (let i = 0; i < child.count; i++) {
                    child.getMatrixAt(i, mat);
                    mat.premultiply(child.matrixWorld);
                    const min = geomBox.min.clone().applyMatrix4(mat);
                    const max = geomBox.max.clone().applyMatrix4(mat);
                    box.expandByPoint(min);
                    box.expandByPoint(max);
                  }
                } else {
                  const clonedBox = geomBox.clone().applyMatrix4(child.matrixWorld);
                  box.expandByPoint(clonedBox.min);
                  box.expandByPoint(clonedBox.max);
                }
              }
            }
          });
          
          const boundingSphere = new THREE.Sphere();
          if (!box.isEmpty()) {
            box.getBoundingSphere(boundingSphere);
            // Add a small margin so it's not completely flush with the screen
            boundingSphere.radius *= 1.5;
            world.camera.controls.fitToSphere(boundingSphere, true);
          }
        }

        world.camera.controls.dispatchEvent({ type: "control" });
        
      } catch (e) {
        console.error("Failed to load connection IFC:", e);
      }
    },
    [ifcLoader]
  );

  // On launch: reopen every IFC the user had loaded last session — the base
  // file first, then the imported ones onto it, so the assembled model comes
  // back as it was left. Only fall back to the bundled default model if nothing
  // was ever saved (first run) or the saved bytes can't be read back.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const session = await loadIfcSession().catch(() => []);
        if (session.length > 0) {
          for (const [i, record] of session.entries()) {
            if (cancelled) return;
            // Already in IndexedDB — re-persisting on load would be redundant.
            await loadIfcBuffer(record.buffer, record.name, {
              persist: false,
              mode: i === 0 ? "replace" : "add",
              report: false,
            });
          }
          return;
        }
        const res = await fetch(DEFAULT_IFC_URL);
        // No local default model is a normal state, not an error: start empty. (The dev server's
        // SPA fallback answers a missing file with index.html, hence the content-type check.)
        if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) return;
        const buffer = await res.arrayBuffer();
        if (!cancelled) await loadIfcBuffer(buffer, DEFAULT_IFC_NAME);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only run once, right after the viewer becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Dropping onto the viewer REPLACES (it's the same gesture as "Load IFC");
  // adding is the explicit Import button, so a stray drop can't silently
  // double up a model.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void loadIfc(file);
    },
    [loadIfc],
  );

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full bg-bg-primary text-text-primary"
      style={{ "--viewer-top-inset": `${topBarHeight}px` } as React.CSSProperties}
      {...{ [PHOTOSHOOT_ATTR]: photoshoot ? "on" : undefined }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* top bar */}
      <div
        ref={topBarRef}
        className="absolute top-0 left-0 right-0 z-20 flex items-center gap-3 px-4 py-2 border-b border-border-primary bg-bg-primary/80 backdrop-blur"
      >
        <span className="text-sm font-semibold">Member Vectors</span>
        <label
          className="text-xs px-2 py-1 rounded border border-border-primary cursor-pointer hover:bg-bg-secondary"
          title="Closes loaded models and opens this file"
        >
          {loading ? "Loading…" : "Load IFC"}
          <input
            type="file"
            accept=".ifc"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadIfc(f);
              e.target.value = "";
            }}
          />
        </label>
        {/* Import = the additive load: same structure delivered as several files,
            assembled into one viewer so joints on the seams can be extracted.
            Needs something to import INTO, hence disabled while empty. */}
        <label
          className={`text-xs px-2 py-1 rounded border border-border-primary ${
            sources.length === 0 || loading
              ? "opacity-40 cursor-not-allowed"
              : "cursor-pointer hover:bg-bg-secondary"
          }`}
          title={
            sources.length === 0
              ? "Load an IFC first"
              : "Add another IFC without closing the loaded model (parts of the same structure)"
          }
        >
          + Import IFC
          <input
            type="file"
            accept=".ifc"
            className="hidden"
            disabled={sources.length === 0 || loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadIfc(f, "add");
              e.target.value = "";
            }}
          />
        </label>
        {/* Space colour. Parked here, between the load controls and the file
            list, because it is a fixed viewer setting: putting it after the
            chips would make it slide left and right as files come and go. */}
        <BackgroundSwatch
          value={backgroundKey}
          onChange={setBackgroundKey}
          custom={customBackground}
          onCustomChange={setCustomBackground}
        />
        {sources.map((s, i) => (
          <span
            key={s.modelId}
            className={`flex shrink-0 items-center gap-1 text-xs text-text-secondary ${
              s.isBase ? "" : "rounded border border-border-primary/60 pl-1"
            }`}
            title={
              s.isBase
                ? `${s.fileName} — base file (Connection Library is keyed to this name; cannot be removed)`
                : `${s.fileName} — imported`
            }
          >
            {i > 0 && <span className="text-text-secondary/50">+</span>}
            <span className={`truncate max-w-[18ch] ${hiddenModelIds.has(s.modelId) ? "opacity-50" : ""}`}>
              {s.fileName}
            </span>
            {/* Paints just THIS file, so an assembly imported from several IFCs
                can be read apart. Keyed by file name (see appearance-store.ts),
                which is why the picker writes `s.fileName` and not `s.modelId`. */}
            <TintSwatch
              value={tintByFileName[s.fileName] ?? null}
              onChange={(hex) =>
                setTintByFileName((prev) => {
                  const next = { ...prev };
                  if (hex === null) delete next[s.fileName];
                  else next[s.fileName] = hex;
                  return next;
                })
              }
              fileName={s.fileName}
              disabled={loading}
            />
            {/* Hides without unmounting — the base file included, since this
                (unlike remove) doesn't touch its buffer or the Connection
                Library association. See `toggleSourceVisibility`. */}
            <button
              type="button"
              className={`shrink-0 rounded px-1 leading-none hover:bg-bg-secondary disabled:opacity-40 [&_path]:fill-current ${
                hiddenModelIds.has(s.modelId) ? "text-blue-400" : "text-white/70 hover:text-white"
              }`}
              disabled={loading}
              title={`${s.fileName} — ${hiddenModelIds.has(s.modelId) ? "show" : "hide"}`}
              aria-label={`${hiddenModelIds.has(s.modelId) ? "Show" : "Hide"} ${s.fileName}`}
              onClick={() => toggleSourceVisibility(s.modelId)}
            >
              {hiddenModelIds.has(s.modelId) ? <EyeHide className="h-4 w-4" /> : <EyeShow className="h-4 w-4" />}
            </button>
            {/* Only imported files are unmountable — see `unmountSource`. */}
            {!s.isBase && (
              <button
                type="button"
                className="shrink-0 rounded px-1 leading-none text-text-secondary hover:bg-bg-secondary hover:text-red-400 disabled:opacity-40"
                disabled={loading}
                title={`Remove ${s.fileName}`}
                aria-label={`Remove ${s.fileName}`}
                onClick={() => void unmountSource(s.modelId)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {/* Conversion is off-thread now, so this actually animates — it is the
            difference between a load the user can watch and a frozen tab. */}
        {loadProgress && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
            <span className="h-1 w-24 overflow-hidden rounded bg-bg-secondary">
              <span
                className="block h-full bg-text-secondary/70 transition-[width] duration-150"
                style={{ width: `${Math.round((loadProgress.value ?? 0) * 100)}%` }}
              />
            </span>
            <span className="tabular-nums">
              {loadProgress.value === null ? "—" : `${Math.round(loadProgress.value * 100)}%`}
            </span>
            <span className="truncate max-w-[14ch]">{loadProgress.stage}</span>
            <button
              type="button"
              className="rounded border border-border-primary px-1 hover:bg-bg-secondary hover:text-red-400"
              onClick={() => abortRef.current?.abort()}
              title="Cancel the load"
            >
              Cancel
            </button>
          </span>
        )}
        {error && <span className="text-xs text-red-400 truncate">{error}</span>}
      </div>

      {/* Load-outcome notices. Centred rather than pinned to a corner: both
          corners below the bar belong to panels (Connection Library left, Member
          Vectors right) that can be open at any width. One column so the import
          report and the gate report stack instead of landing on top of each
          other when a single load produces both. */}
      <div
        className="pointer-events-none absolute left-1/2 z-30 flex w-full max-w-lg -translate-x-1/2 flex-col gap-2"
        style={{ top: `calc(var(--viewer-top-inset) + 8px)` }}
      >
      {importReport && (
        <div
          className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border-primary bg-bg-primary/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
        >
          <div className="flex flex-col gap-1">
            <span className="font-medium">
              <span className="text-text-secondary">Import:</span> {importReport.fileName}
            </span>
            {importReport.clashCount > 0 ? (
              <span className="text-amber-400">
                {importReport.clashCount} element(s) exist in both files (same GlobalId). Both were loaded —
                they draw on top of each other and clicking is ambiguous about which one is selected.
              </span>
            ) : (
              <span className="text-text-secondary">No clashing elements.</span>
            )}
            {importReport.frameMismatch && (
              <span className="text-red-400">
                WARNING: this file places the structure in a different world frame than the base file (origins{" "}
                {Math.round(importReport.frameMismatch.originDeltaMm).toLocaleString("en-US")} mm apart
                {importReport.frameMismatch.rotationDiffers ? ", plus a rotation difference" : ""}). Even if they
                look aligned on screen, cross-file connection geometry is NOT reliable.
              </span>
            )}
          </div>
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1 text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
            onClick={() => setImportReport(null)}
            title="Close"
          >
            ×
          </button>
        </div>
      )}

      {/* Geometry refused at the gate. Never silent: an element that vanished
          without a word is exactly the failure this mechanism trades the hang
          for, so the count, the reason and the identity are all shown. */}
      {geometryReports.map((report) => (
        <div
          key={report.fileName}
          className="pointer-events-auto flex items-start gap-3 rounded-lg border border-amber-500/40 bg-bg-primary/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-amber-400">
              {report.dropped.length} element(s) had their geometry skipped
              <span className="font-normal text-text-secondary"> — {report.fileName}</span>
            </span>
            <span className="text-text-secondary">
              These elements' bodies are too complex to draw (nested boolean operations). They remain in the
              model tree and properties, only missing from the view; vector extraction reads the original
              file and is unaffected.
            </span>
            {report.dropped.slice(0, 4).map((body) => (
              <span key={body.expressId} className="truncate text-text-secondary/80">
                #{body.expressId} {body.ifcType.replace(/^IFC/, "")} — {body.booleanCount} boolean
                {body.name ? ` — ${body.name}` : ""}
              </span>
            ))}
            {report.dropped.length > 4 && (
              <span className="text-text-secondary/60">…and {report.dropped.length - 4} more</span>
            )}
          </div>
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1 text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
            onClick={() => setGeometryReports((prev) => prev.filter((r) => r.fileName !== report.fileName))}
            title="Close"
          >
            ×
          </button>
        </div>
      ))}
      </div>

      {/* h-full w-full alongside inset-0 on purpose: components-front's 2D renderer
          writes an inline `position: relative` onto this container (setupHtmlRenderer),
          and under `relative` the inset-0 offsets stop stretching it — height falls back
          to `auto`, i.e. to the canvas, whose size the renderer in turn reads back off
          the container. That loop can settle at 0×0 and never recover. An explicit
          100%/100% is size-identical while the container is still absolute, and keeps it
          correct once the library flips it to relative. */}
      <div ref={viewerRef} className="absolute inset-0 h-full w-full" data-viewer-container />

      {ready && (
        <ControlPanel
          components={components}
          worldRef={worldRef}
          avoidRightEdgePx={memberVectorsPanelWidth}
          avoidLeftEdgePx={leftObstacleRightPx}
          onBarWidthChange={setControlBarWidth}
          photoshoot={photoshoot}
          onPhotoshootChange={setPhotoshoot}
        />
      )}
      {ready && <PlateDxfButton components={components} active={ready} getIfcSources={getIfcSources} />}
      {ready && (
        <MemberVectorsPanel
          components={components}
          worldRef={worldRef}
          getIfcSources={getIfcSources}
          // Re-render signal AND the purge list: `getIfcSources` reads a ref, so
          // it can't tell the panel that the set changed. Declarative (the ids
          // that ARE loaded) rather than an "unmounted" event, so no purge can be
          // missed and replace/import/unmount are all handled by one path.
          loadedModelIds={loadedModelIds}
          isIfcLoaderSetupCompleted={ready}
          // The BASE file keys the library: it survives imports, so connections
          // saved before and after an import stay in one place.
          ifcName={baseSource(sources)?.fileName ?? null}
          isOpen
          onClose={() => undefined}
          isRightPanelVisible={memberVectorsRightPanelOpen}
          onRightPanelVisibilityChange={setMemberVectorsRightPanelOpen}
          ifcSource={ifcSource}
          setIfcSource={setIfcSource}
          onPanelWidthChange={setMemberVectorsPanelWidth}
          onLibraryPanelWidthChange={setLibraryPanelWidth}
          selectionMinWidth={selectionMinWidth}
          selectionDefaultWidth={selectionDefaultWidth}
          selectionMaxWidth={selectionMaxWidth}
          resultsMinWidth={resultsMinWidth}
          resultsDefaultWidth={resultsDefaultWidth}
          resultsMaxWidth={resultsPanelMaxWidth}
          onOpenConnectionDesign={(rows, iomXml, nodeMm) => {
            setConnectionDesignMemberRows(rows);
            setConnectionDesignIomXml(iomXml);
            setConnectionDesignNodeMm(nodeMm);
            setConnectionDesignPanelOpen(true);
          }}
        />
      )}
      {ready && (
        <ConnectionDesignPanel
          isOpen={connectionDesignPanelOpen}
          onClose={() => setConnectionDesignPanelOpen(false)}
          memberRows={connectionDesignMemberRows}
          iomXml={connectionDesignIomXml}
          onPanelWidthChange={setConnectionDesignPanelWidth}
          onLoadConnectionIfc={connectionDesignNodeMm ? (buffer) => handleLoadConnectionIfc(buffer, connectionDesignNodeMm) : undefined}
          onStartAnalysis={() => setMemberVectorsRightPanelOpen(false)}
        />
      )}

      {/* Survives the photoshoot CSS via `data-photoshoot-keep`; everything else
          in the root is hidden by it (see globals.css). */}
      {photoshoot && showPhotoshootHint && (
        <div
          data-photoshoot-keep
          className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full bg-bg-primary/70 px-3 py-1 text-xs text-text-secondary backdrop-blur transition-opacity"
        >
          Photoshoot — press Esc to bring the interface back
        </div>
      )}

      {/* empty / drop state */}
      {sources.length === 0 && (
        <div
          className={`absolute inset-0 z-10 flex items-center justify-center pointer-events-none ${
            dragOver ? "bg-brand-primary/10" : ""
          }`}
        >
          <div className="text-center">
            <p className="text-lg font-medium">Drop an IFC file here</p>
            <p className="text-sm text-text-secondary mt-1">or use “Load IFC” — everything runs in your browser.</p>
          </div>
        </div>
      )}
    </div>
  );
}
