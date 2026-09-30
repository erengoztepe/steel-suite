"use client";

import type { OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import { BoundingBoxer, Components } from "@thatopen/components";
import { Highlighter, type PostproductionRenderer } from "@thatopen/components-front";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import * as XLSX from "xlsx";

import { Button } from "@/components/button";
import { RightPanelShell, type RightPanelShellHandle } from "@/components/viewer-panels/RightPanelShell";
import {
  PANEL_COLLAPSE_MS,
  PANEL_MOVE_EASE,
  fillPanelBody,
  runPanelScreenTransition,
  settlePanelBody,
} from "@/components/viewer-panels/panel-motion";
import { ConnectionLibraryPanel } from "./ConnectionLibraryPanel";
import { loadConnections, saveConnection, removeConnection, renameConnection, type SavedConnection } from "./connection-library-store";
import {
  applyStoreyIsolation,
  clearStoreyIsolation,
} from "@/modules/bim-compliance/StandaloneViewer/storey-isolation/applyStoreyIsolation";
import { ISOLATION_TRANSITION_MS } from "@/modules/bim-compliance/StandaloneViewer/storey-isolation/isolation-transition";

import { type GetIfcSources } from "@/modules/bim-compliance/ifc-sources";

import { captureViewpoint, applyViewpoint, frameMembersTopDown } from "./camera-viewpoint";
import { clearMemberVectors, drawMemberVectors, hideExtraneousLines, restoreExtraneousLines } from "./draw-vectors";
import {
  buildTagIndexAcrossModels,
  extractMemberProfilesAcrossModels,
  extractMemberVectorsAcrossModels,
  type MemberTarget,
} from "./extract-across-models";
import { focusOnMember } from "./focus-on-member";
import { formatMemberLabel } from "./member-label";
import { emitConnectionIom } from "./emit-iom";
import { buildOrientedRows } from "./build-oriented-rows";
import { requireSurface } from "./doc-metrics";
import JointDiagram from "./joint-diagram";
import { anchorNodeToBearing, solveJoint, type JointSolution } from "./joint-solver";
import { classifyThroughMembers, suggestBearingMember, type BearingSuggestion } from "./suggest-bearing-member";
import type { MemberVectorRow, OrientedMemberVectorRow } from "./types";
import {
  resolveMemberByGlobalIdAnyModel,
  useMemberSelection,
  type SelectedMember,
} from "./use-member-selection";

type WorldRef = MutableRefObject<any>;

interface MemberVectorsPanelProps {
  components: Components;
  worldRef: WorldRef;
  /**
   * The raw bytes behind EVERY model in the viewer, keyed by modelId. Not a
   * single buffer: a structure delivered as several IFCs is imported into one
   * viewer, and each extraction has to run against the file its member came
   * from (see `ifc-sources.ts`).
   */
  getIfcSources: GetIfcSources;
  /**
   * modelIds of the files currently in the viewer. The panel reconciles its own
   * per-member state against this, so a file taken back out ("unmount") can't
   * leave members, snapshots or results behind that point at a disposed model.
   * Declarative rather than an "unmounted" event: a missed event would be a
   * silent wrong answer, a missed re-render is just a late one.
   */
  loadedModelIds: string[];
  isIfcLoaderSetupCompleted: boolean;
  /**
   * File name of the BASE IFC in the viewer — the key the Connection Library is
   * stored under. Owned by the host because only the host knows when a new file
   * replaces the old one: deriving it here from the last-opened-IFC record would
   * freeze it at mount time, so connections saved after loading a second file
   * went to the previous file's library and looked lost on the next launch.
   * Imports do NOT change it, so one library spans the assembled model.
   */
  ifcName: string | null;
  /** Whether the panel is open — the host owns this state (no router coupling). */
  isOpen: boolean;
  /** Called when the user closes the panel; the host clears its open state. */
  onClose: () => void;
  /**
   * Which authoring tool exported the current IFC — lifted to the host (rather
   * than local panel state) so it can persist across panel opens/closes.
   */
  ifcSource: "tekla" | "autodesk";
  setIfcSource: (v: "tekla" | "autodesk") => void;
  /**
   * Reports this panel's current on-screen width (px) to the host — lets the
   * bottom viewer control bar (Views/Labels) shift out of the way when this
   * panel's live-resized width encroaches on it.
   */
  onPanelWidthChange?: (width: number) => void;
  /**
   * Reports the left Connection Library panel's current on-screen width (px) to
   * the host — same purpose as `onPanelWidthChange`, from the other side: it's
   * what the bottom control bar's leftward avoid-slide must stop short of.
   */
  onLibraryPanelWidthChange?: (width: number) => void;
  /**
   * Selection- and results-screen panel width bounds (px), computed by the
   * host by scaling its tuned reference values off the live root container
   * width — keeps the same on-screen proportions on any monitor or window
   * size. The max widths are additionally capped at the point where the bottom
   * control bar, sliding left in lockstep with this panel, runs out of its own
   * travel. Each falls back to its own reference-width value if the host hasn't
   * computed one yet.
   */
  selectionMinWidth?: number;
  selectionDefaultWidth?: number;
  selectionMaxWidth?: number;
  resultsMinWidth?: number;
  resultsDefaultWidth?: number;
  resultsMaxWidth?: number;
  /** Whether the right panel (Selection/Results) should be rendered. */
  isRightPanelVisible?: boolean;
  onRightPanelVisibilityChange?: (visible: boolean) => void;
  /** Called when the user wants to open the Connection Design panel from the results view. */
  onOpenConnectionDesign?: (rows: OrientedMemberVectorRow[], iomXml: string, nodeMm: [number, number, number] | null) => void;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
type Vec3 = [number, number, number];

/**
 * Rx/Ry/Rz display values: the unit vector ×10000, rounded to whole numbers
 * (decimal-free) — EXCEPT when the member is exactly axis-aligned (every
 * component rounds to 0 or ±10000), where the ×10000 form is just noisy
 * zeros/ones with extra digits; show the reduced ±1/0 form instead.
 */
function formatDirectionComponents(unit: Vec3): Vec3 {
  const scaled = unit.map((u) => Math.round(u * 10000)) as Vec3;
  const axisAligned = scaled.every((v) => v === 0 || Math.abs(v) === 10000);
  return axisAligned ? (scaled.map((v) => v / 10000) as Vec3) : scaled;
}

/** Compact labels for the "Src" column (centerline extraction method). */
const CENTERLINE_SRC_ABBR: Record<string, string> = {
  "axis-polyline": "poly",
  "axis-line": "line",
  "axis-circle": "circle",
  "body-extrusion": "extr",
  "mesh-pca": "mesh",
};

function toCsv(rows: OrientedMemberVectorRow[], node: Vec3 | null): string {
  requireSurface();
  const nx = node ? r3(node[0]) : "";
  const ny = node ? r3(node[1]) : "";
  const nz = node ? r3(node[2]) : "";
  const header = [
    "Tag", "Name", "Class", "Type", "Length_mm",
    "Node_X", "Node_Y", "Node_Z",
    "Vector_X", "Vector_Y", "Vector_Z",
    "Unit_X", "Unit_Y", "Unit_Z",
    // IDEA StatiCa inputs: rotation + local-frame offset (ex is not computed
    // — IDEA trims freely along the member axis, see types.ts). Rotation_deg
    // prefers the IFC "Cross-Section Rotation" pset over the geometric
    // estimate (Geometric_Rotation_deg) — cross-checked against IDEA on
    // several members spanning every kind of mismatch found in this file;
    // the pset matched the model's real orientation every time, the
    // geometric estimate did not.
    "Rotation_deg", "Offset_ey_mm", "Offset_ez_mm",
    "Eccentricity_mm", "Alignment_deg", "Geometric_Rotation_deg",
    "Offset_global_X", "Offset_global_Y", "Offset_global_Z",
    "Close_X", "Close_Y", "Close_Z",
    "Far_X", "Far_Y", "Far_Z",
    "SectionArea_mm2", "Iy_cm4", "Iz_cm4",
    "Profile", "Material", "Bearing", "Flipped",
    "Centerline_Source", "Centerline_Agreement_mm",
  ];
  const lines = rows.map((r) =>
    [
      r.tag, `"${r.name.replace(/"/g, '""')}"`, r.ifcClass, r.isContinuous ? "Continuous" : "Ended", r.length,
      nx, ny, nz,
      ...r.vector, ...r.unit,
      r.rotationDeg ?? r.rotationIdeaDeg ?? "", r.offsetLocal[1], r.offsetLocal[2], r.eccentricityMm, r.alignmentDeg,
      r.rotationIdeaDeg ?? "",
      ...r.offset, ...r.start, ...r.end,
      r.sectionAreaMm2 ?? "", r.iStrongCm4 ?? "", r.iWeakCm4 ?? "",
      r.profile, r.material, r.isBearing ? "yes" : "", r.flipped ? "yes" : "",
      r.centerlineSource, r.centerlineAgreementMm ?? "",
    ].join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

/** Mirrors the on-screen results table (18 columns) as a real .xlsx workbook. */
function toTableXlsx(rows: OrientedMemberVectorRow[], bearingGlobalId: string | null): Uint8Array {
  requireSurface();
  const header = [
    "Bearing", "Type", "Class", "Tag", "Profile", "Len",
    "<Rx,Ry,Rz>", "Alfa", "ey", "ez", "Ecc",
    "A", "Iy", "Iz", "Cross-section axes", "Conf.", "Src", "Src_Agreement_mm",
  ];
  const data = rows.map((r) => {
    const rxyz = formatDirectionComponents(r.unit);
    return [
      r.globalId === bearingGlobalId ? "yes" : "",
      r.isContinuous ? "Continuous" : "Ended",
      r.ifcClass.replace("Ifc", ""),
      r.tag || "",
      r.profile || "",
      r.length,
      `${rxyz[0]} ${rxyz[1]} ${rxyz[2]}`,
      r.rotationDeg ?? r.rotationIdeaDeg ?? "",
      num(r.offsetLocal[1]), num(r.offsetLocal[2]),
      r.eccentricityMm,
      r.sectionAreaMm2 ?? "", r.iStrongCm4 ?? "", r.iWeakCm4 ?? "",
      `A(${r.crossSectionAxisA.map(num).join(",")}) B(${r.crossSectionAxisB.map(num).join(",")})`,
      r.axisConfidence,
      CENTERLINE_SRC_ABBR[r.centerlineSource] ?? r.centerlineSource,
      r.centerlineAgreementMm ?? "",
    ];
  });
  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Member Vectors");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

const num = (n: number) => (Object.is(n, -0) ? 0 : n);

const MemberVectorsPanel = ({
  components,
  worldRef,
  getIfcSources,
  loadedModelIds,
  isIfcLoaderSetupCompleted,
  ifcName,
  isOpen,
  onClose,
  ifcSource,
  setIfcSource,
  onPanelWidthChange,
  onLibraryPanelWidthChange,
  selectionMinWidth,
  selectionDefaultWidth,
  selectionMaxWidth,
  resultsMinWidth,
  resultsDefaultWidth,
  resultsMaxWidth,
  isRightPanelVisible = true,
  onRightPanelVisibilityChange,
  onOpenConnectionDesign,
}: MemberVectorsPanelProps) => {
  const { members, setMembers } = useMemberSelection(
    components,
    isOpen && isIfcLoaderSetupCompleted,
  );

  const [bearingGlobalId, setBearingGlobalId] = useState<string | null>(null);
  const [geomTypeById, setGeomTypeById] = useState<Map<string, "Continuous" | "Ended">>(new Map());
  const [manualFlips, setManualFlips] = useState<Set<string>>(new Set());
  const [rawRows, setRawRows] = useState<MemberVectorRow[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Requested members that came back with NO resolvable centerline in the
   * mode just used. In Autodesk mode this always means "no Axis/parametric
   * body at all" — the resolver's own priority rules guarantee a cheap
   * candidate would have won if one existed, so `suggestTekla` is safe to
   * derive purely from which mode was active, no extra IFC scan needed.
   */
  const [missingInfo, setMissingInfo] = useState<{ count: number; suggestTekla: boolean } | null>(null);
  const [bearingSuggestion, setBearingSuggestion] = useState<BearingSuggestion | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * What the panel SHOWS, kept apart from `rawRows`: a screen switch is animated
   * (panel-motion.ts), so the old screen has to stay up while it fades out, and
   * the results screen has to exist — as a placeholder — long before extraction
   * hands over any rows (extraction only starts once the 3D isolation lands).
   */
  const [screen, setScreen] = useState<"selection" | "loading" | "results">("selection");
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const shellRef = useRef<RightPanelShellHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const screenSwitchRef = useRef<{ id: number; done: Promise<void> }>({ id: 0, done: Promise.resolve() });
  const selectionWidth = selectionDefaultWidth ?? 300;
  const resultsWidth = resultsDefaultWidth ?? 550;
  /** Animated screen switch; a newer call takes over from one still running. */
  const switchScreen = useCallback((targetWidth: number, swap: () => void): Promise<void> => {
    const id = screenSwitchRef.current.id + 1;
    const shell = shellRef.current;
    const body = bodyRef.current;
    const done =
      shell && body
        ? runPanelScreenTransition({ shell, body, targetWidth, swap, isCurrent: () => screenSwitchRef.current.id === id })
        : Promise.resolve().then(swap);
    screenSwitchRef.current = { id, done };
    return done;
  }, []);
  /** Drops a running screen switch — for a close, which animates the panel itself. */
  const abortScreenSwitch = useCallback(() => {
    screenSwitchRef.current = { id: screenSwitchRef.current.id + 1, done: Promise.resolve() };
    settlePanelBody(bodyRef.current);
  }, []);
  const [tagQuery, setTagQuery] = useState("");
  const [tagSearching, setTagSearching] = useState(false);
  const [tagSearchError, setTagSearchError] = useState<string | null>(null);

  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);

  // Re-read the library whenever the loaded file changes — the library is
  // per-IFC, and the store is async (disk-backed), so a late response from the
  // previous file must not land in the new file's list.
  useEffect(() => {
    if (!ifcName) {
      setSavedConnections([]);
      return;
    }
    let cancelled = false;
    void loadConnections(ifcName).then((list) => {
      if (!cancelled) setSavedConnections(list);
    });
    return () => {
      cancelled = true;
    };
  }, [ifcName]);
  // Tag → member(s) lookup spanning every loaded file, built lazily on first
  // search — avoids re-scanning the IFCs on every "go to element" lookup. Each
  // hit keeps its modelId because a Tag is only unique within one file.
  //
  // Cached against the SET of loaded files, not for the whole session: importing
  // another IFC has to invalidate it, or the index silently keeps answering from
  // the files that were loaded when it was first built and every Tag in the new
  // file reads as "not found".
  const tagIndexRef = useRef<{ key: string; index: Map<string, MemberTarget[]> } | null>(null);

  // Profile hint shown next to each member on the selection screen — resolved
  // lazily (fast, no body-geometry parsing) whenever the selection changes.
  const [memberProfiles, setMemberProfiles] = useState<Map<string, string>>(new Map());

  // The node is ANCHORED to the chosen bearing member's axis (IDEA convention),
  // so it depends on `bearingGlobalId` — changing the bearing pick (radio in the
  // results view) relocates the node and live-recomputes every offset/
  // eccentricity. This is what makes the "ended bearing" case correct. The
  // along-axis position is the exact constrained least-squares minimum over the
  // ATTACHED members' axis lines; in the degenerate (near-parallel) case it
  // falls back to the Ended attached members' close-end centroid — so it also
  // depends on `geomTypeById` (toggling a member's type can relocate the node).
  const jointSolution = useMemo<JointSolution | null>(() => {
    if (!rawRows) return null;
    const inputs = rawRows.map((r) => ({
      globalId: r.globalId,
      start: r.start,
      end: r.end,
      unit: r.unit,
      tangentStart: r.tangentStart,
      tangentEnd: r.tangentEnd,
      curve: r.curve,
    }));
    const bearingId = bearingGlobalId ?? rawRows[0]?.globalId ?? null;
    const base = solveJoint(inputs);
    const endedCloseEnds = base
      ? base.members
          .filter((s) => s.globalId !== bearingId && geomTypeById.get(s.globalId) === "Ended")
          .map((s) => s.close)
      : [];
    return anchorNodeToBearing(inputs, bearingId, { endedCloseEnds });
  }, [rawRows, bearingGlobalId, geomTypeById]);

  const orientedRows = useMemo(
    () => (rawRows ? buildOrientedRows(rawRows, jointSolution, bearingGlobalId, geomTypeById, manualFlips) : null),
    [rawRows, jointSolution, bearingGlobalId, geomTypeById, manualFlips],
  );

  // Snapshot of modelId/localId per member, captured at extract time BEFORE
  // isolation clears the live highlighter selection (which would empty `members`).
  const [memberRefs, setMemberRefs] = useState<Map<string, { modelId: string; localId: number }>>(new Map());

  // Redraw the joint overlay whenever the oriented result changes.
  useEffect(() => {
    if (!orientedRows) return;
    drawMemberVectors(
      components,
      worldRef.current,
      orientedRows,
      memberRefs,
      jointSolution?.node ?? null,
      bearingGlobalId ?? orientedRows[0]?.globalId ?? null,
    );
  }, [orientedRows, components, worldRef, memberRefs, jointSolution, bearingGlobalId]);

  /**
   * Reverse of the viewer→table sync: clicking a results row selects that
   * member in the (isolated) viewer via the same Highlighter "select" state
   * `useMemberSelection` already listens to, so `members` — and therefore the
   * table's own highlight — pick it back up automatically.
   */
  const handleSelectRow = useCallback(
    (globalId: string) => {
      const ref = memberRefs.get(globalId);
      if (!ref) return;
      components.get(Highlighter).highlightByID(
        "select",
        { [ref.modelId]: new Set([ref.localId]) },
        true,
      );
    },
    [components, memberRefs],
  );

  // All members currently selected in the viewer (ctrl+click multi-select included).
  const selectedGlobalIds = useMemo(() => new Set(members.map((m) => m.globalId)), [members]);

  // Resolve profile names for the selection-screen list — best-effort, no
  // body-geometry parsing, so it stays fast as the selection changes. Guarded
  // against out-of-order responses from rapid successive selection changes.
  const profileCallIdRef = useRef(0);
  useEffect(() => {
    if (rawRows) return; // only needed on the selection screen
    // Carries each member's modelId so the lookup is routed to its own file.
    const targets: MemberTarget[] = members
      .filter((m) => !memberProfiles.has(m.globalId))
      .map((m) => ({ globalId: m.globalId, modelId: m.modelId }));
    if (targets.length === 0) return;
    const callId = ++profileCallIdRef.current;
    extractMemberProfilesAcrossModels(getIfcSources(), targets)
      .then((resolved) => {
        if (callId !== profileCallIdRef.current) return;
        // Bail on an empty result instead of publishing a new Map identity.
        // `memberProfiles` is this effect's own dependency, so a no-op update
        // re-ran it — and a member whose profile legitimately never resolves
        // (this lookup skips swept-solid geometry by design) then re-paid a full
        // web-ifc WASM parse of the file on every render, forever.
        if (resolved.size === 0) return;
        setMemberProfiles((prev) => {
          const next = new Map(prev);
          for (const [gid, profile] of resolved) next.set(gid, profile);
          return next;
        });
      })
      .catch(() => undefined);
  }, [members, rawRows, getIfcSources, memberProfiles]);

  const removeMember = useCallback(
    (globalId: string) => setMembers((prev) => prev.filter((m) => m.globalId !== globalId)),
    [setMembers],
  );

  /**
   * Jump straight to a member by Tag OR GlobalId: resolves it, adds it to the
   * selection (if not already present), highlights it in the viewer, and
   * frames the camera on it. Tries the query as a GlobalId first (cheap,
   * exact) regardless of `ifcSource`, then falls back to the Tag index — used
   * to quickly cross-check specific members (e.g. Alfa/rotation QA cases)
   * without hunting for them in the model.
   */
  const handleGoToTag = useCallback(async () => {
    const query = tagQuery.trim();
    if (!query) return;
    setTagSearchError(null);
    setTagSearching(true);
    try {
      const sources = getIfcSources();
      if (sources.length === 0) throw new Error("IFC buffer not available for the active model.");

      const byGuid = await resolveMemberByGlobalIdAnyModel(components, query);
      if (byGuid) {
        setMembers((prev) => (prev.some((m) => m.globalId === byGuid.globalId) ? prev : [...prev, byGuid]));
        components.get(Highlighter).highlightByID(
          "select",
          { [byGuid.modelId]: new Set([byGuid.localId]) },
          false,
        );
        void focusOnMember(components, worldRef.current, byGuid.modelId, byGuid.localId);
        return;
      }

      const tagIndexKey = sources.map((s) => s.modelId).join("|");
      if (tagIndexRef.current?.key !== tagIndexKey) {
        tagIndexRef.current = { key: tagIndexKey, index: await buildTagIndexAcrossModels(sources) };
      }

      const hits = tagIndexRef.current.index.get(query) ?? [];
      if (hits.length === 0) {
        setTagSearchError(`"${query}" not found (tried as Tag and GUID).`);
        return;
      }
      const resolved = await resolveMemberByGlobalIdAnyModel(components, hits[0].globalId);
      if (!resolved) {
        setTagSearchError(`"${query}" could not be resolved in the model.`);
        return;
      }

      setMembers((prev) => (prev.some((m) => m.globalId === resolved.globalId) ? prev : [...prev, resolved]));
      components.get(Highlighter).highlightByID(
        "select",
        { [resolved.modelId]: new Set([resolved.localId]) },
        false,
      );
      // Fire-and-forget: the camera transition shouldn't block re-enabling the
      // search UI (and its promise only settles once the animation finishes).
      void focusOnMember(components, worldRef.current, resolved.modelId, resolved.localId);
    } catch (e) {
      setTagSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setTagSearching(false);
    }
  }, [tagQuery, components, getIfcSources, setMembers, worldRef]);

  /**
   * `sourceOverrideArg` lets a caller force a specific Tekla/Autodesk value for
   * THIS extraction without waiting for the `setIfcSource` state update to
   * commit (state updates are async, so reading `ifcSource` right after
   * calling `setIfcSource` in the same handler would still see the old value).
   * Used by the results-screen toggle to re-extract with the just-picked
   * source in one action, without a stale-closure race.
   *
   * NOTE the explicit guard: this handler is also wired straight to a Button's
   * onClick, which would otherwise pass a React click Event as the first arg —
   * that must NOT be mistaken for a source override (it would force Autodesk
   * mode AND suppress the first-attempt auto-fallback). Only the two literal
   * strings count; anything else (an event, undefined) means "no override".
   */
  const handleExtract = useCallback(async (sourceOverrideArg?: unknown) => {
    const sourceOverride: "tekla" | "autodesk" | undefined =
      sourceOverrideArg === "tekla" || sourceOverrideArg === "autodesk" ? sourceOverrideArg : undefined;
    // A switch is a results-screen re-extract with an explicit mode; the very
    // first extract comes from the Selection screen's button with no override.
    const isSwitch = sourceOverride !== undefined;
    // Target member set:
    //  - FIRST extract → the live viewer selection (`members`), the user's picks.
    //  - SWITCH → the FROZEN snapshot (`memberRefs`) captured at the first
    //    extract. Never the live `members` here: isolating the model clears the
    //    Highlighter selection, and clicking a results row re-selects just THAT
    //    one member, so `members` on the results screen is partial/stale —
    //    reading it (and then overwriting `memberRefs` with it) is exactly what
    //    shrank the group to a single member across a Tekla→Autodesk→Tekla
    //    round-trip.
    const targets = isSwitch
      ? Array.from(memberRefs.entries()).map(([globalId, ref]) => ({ globalId, ...ref }))
      : members.length > 0
        ? members.map((m) => ({ globalId: m.globalId, modelId: m.modelId, localId: m.localId }))
        : Array.from(memberRefs.entries()).map(([globalId, ref]) => ({ globalId, ...ref }));
    if (targets.length === 0) return;
    // Defence in depth behind the loaded-ids reconciliation: never route an
    // extraction at a file that is not loaded. Skipping such a member silently
    // would drop it from the joint and re-solve on a smaller set than the user
    // picked — refusing says what actually happened instead.
    const loadedForExtract = new Set(loadedModelIds);
    const unloadedTargets = targets.filter((t) => !loadedForExtract.has(t.modelId));
    if (unloadedTargets.length > 0) {
      setError(
        `${unloadedTargets.length} member(s) now belong to a file that is no longer loaded. ` +
          "Re-import that file or remove these members from the selection.",
      );
      return;
    }
    // Only the very first extraction (no explicit override, nothing on
    // screen yet) auto-falls-back below — a switch triggered from the results
    // screen is the user explicitly picking a mode, so it's honored literally
    // and never silently escalated further.
    const isFirstAttempt = sourceOverride === undefined && rawRows === null;
    let effectiveSource = sourceOverride ?? ifcSource;
    setError(null);
    setMissingInfo(null);
    setExtracting(true);
    // The panel makes room for the results while the 3D isolation runs; the
    // rows replace this placeholder once extraction hands them over.
    if (!isSwitch) void switchScreen(resultsWidth, () => setScreen("loading"));
    try {
      const sources = getIfcSources();
      if (sources.length === 0) throw new Error("IFC buffer not available for the active model.");

      const visibleByModel: Record<string, Set<number>> = {};
      for (const t of targets) {
        (visibleByModel[t.modelId] ??= new Set<number>()).add(t.localId);
      }
      // Snapshot member refs before isolation clears the highlighter selection.
      setMemberRefs(new Map(targets.map((t) => [t.globalId, { modelId: t.modelId, localId: t.localId }])));
      // The rest of the model fades out while the camera glides to the fit;
      // extraction starts only once that lands, because web-ifc runs
      // synchronously on this thread and would freeze the animation mid-way.
      // A switch re-isolates the SAME members, so it stays instant: animating it
      // starts with `resetVisible`, and the hidden model would flash back in
      // (measured: drawn groups 132 → 3564 within 0.2 s) only to fade out again.
      await applyStoreyIsolation(components, worldRef as any, visibleByModel, {
        transitionMs: isSwitch ? undefined : ISOLATION_TRANSITION_MS,
      });
      if (worldRef.current) hideExtraneousLines(worldRef.current as any);

      // Each target carries its own modelId, so a joint whose members come from
      // different imported files is extracted file by file and merged back into
      // this order — the order the joint solver reads as the member sequence.
      const orderedTargets: MemberTarget[] = targets
        .filter((t) => t.globalId)
        .map((t) => ({ globalId: t.globalId, modelId: t.modelId }));
      const orderedGlobalIds = orderedTargets.map((t) => t.globalId);
      let rows = await extractMemberVectorsAcrossModels(sources, orderedTargets, {
        allowBrepFallback: effectiveSource === "tekla",
      });

      // Eliminate-the-failing-option, not guess-up-front: a totally empty
      // Autodesk-mode result always means "no Axis/parametric body at all" for
      // every selected member (the resolver's priority order guarantees a
      // cheap candidate would have won over mesh if one existed) — exactly
      // the gap the Tekla mesh-PCA fallback is for. Try it automatically, once,
      // only on the first extraction; if it actually finds something, adopt it
      // (and correct the toggle to reflect what really worked) instead of
      // making the user discover and click through the switch themselves.
      if (isFirstAttempt && rows.length === 0 && effectiveSource === "autodesk") {
        const teklaRows = await extractMemberVectorsAcrossModels(sources, orderedTargets, {
          allowBrepFallback: true,
        });
        if (teklaRows.length > 0) {
          rows = teklaRows;
          effectiveSource = "tekla";
          setIfcSource("tekla");
        }
      }

      // Which requested members came back with nothing. In AUTODESK mode this
      // always means "no Axis/parametric-body representation at all" — the
      // resolver always prefers a cheap candidate over the mesh fallback when
      // one exists, so a miss here is never "mesh would've been tried and
      // lost." That's exactly the set the Tekla mesh-PCA fallback exists for.
      // In TEKLA mode a miss already went through the mesh fallback too, so
      // nothing is left to try — it's a genuine data gap either way.
      const resolvedIds = new Set(rows.map((r) => r.globalId));
      const missingCount = orderedGlobalIds.filter((gid) => !resolvedIds.has(gid)).length;
      if (missingCount > 0) setMissingInfo({ count: missingCount, suggestTekla: effectiveSource === "autodesk" });

      if (rows.length === 0) {
        // isFirstAttempt reaching here means BOTH options are exhausted: Tekla
        // is a strict superset of Autodesk's capabilities (same cheap
        // candidates PLUS the mesh fallback), so either the auto-fallback
        // above already tried Tekla and it also found nothing, or this attempt
        // started in Tekla mode directly — a Tekla failure alone already rules
        // out Autodesk too. Nothing left to switch to (and no toggle is even
        // visible on the selection screen), so send the user BACK to selection
        // with their picks intact: isolation cleared the live highlighter, so
        // re-apply it from the snapshot (repopulates `members` via
        // useMemberSelection) and restore the full model view for re-picking.
        setError(
          isFirstAttempt
            ? "Neither Autodesk nor Tekla extraction found any geometry (Axis, parametric body, or mesh) for these members. Adjust the selection and try again."
            : effectiveSource === "autodesk"
              ? "No Axis/body geometry found for the selected members in Autodesk mode. Switch to Tekla below to try the mesh-based fallback."
              : "No centerline found for the selected members with either method (Axis, parametric body, or mesh).",
        );
        if (rawRows === null) {
          // First-attempt total failure → back to selection with picks intact.
          void switchScreen(selectionWidth, () => setScreen("selection"));
          // Re-paint the picks BEFORE fading the rest back in: the fade leaves
          // only select-highlighted members opaque, so unpainted picks would
          // blink out and fade in along with everything else.
          if (worldRef.current) restoreExtraneousLines(worldRef.current as any);
          const byModel: Record<string, Set<number>> = {};
          for (const t of targets) (byModel[t.modelId] ??= new Set<number>()).add(t.localId);
          await components.get(Highlighter).highlightByID("select", byModel, false);
          await clearStoreyIsolation(components, worldRef as any, { transitionMs: ISOLATION_TRANSITION_MS });
        } else {
          // Switch-triggered re-extract that found nothing → CLEAR the previous
          // (other-mode) table so no stale data lingers under the new mode.
          // Land on an empty results screen showing just the error, with the
          // toggle still available to switch back to the mode that worked.
          clearMemberVectors(worldRef.current);
          setBearingSuggestion(null);
          setGeomTypeById(new Map());
          setManualFlips(new Set());
          setRawRows([]);
        }
        return;
      }

      // Auto-suggest the bearing member: continuity-through-node + largest
      // section. Only auto-apply on high confidence; otherwise fall back to the
      // first member and surface the low-confidence hint in the UI.
      const suggestion = suggestBearingMember(rows);
      setBearingSuggestion(suggestion);
      // Each extract is a fresh computation — apply the high-confidence suggestion
      // (don't preserve a stale pick from a previous extract). Manual override is
      // a separate user action afterwards.
      const autoPick = suggestion?.confidence === "high" ? suggestion.globalId : rows[0].globalId;
      setBearingGlobalId(autoPick);

      // Auto-classify each member's geometrical type (Continuous/Ended) from the
      // same through-the-joint test used for the bearing suggestion — a member
      // can run through the joint independently of which one is the bearing.
      const base = solveJoint(
        rows.map((r) => ({
          globalId: r.globalId,
          start: r.start,
          end: r.end,
          unit: r.unit,
          tangentStart: r.tangentStart,
          tangentEnd: r.tangentEnd,
          curve: r.curve,
        })),
      );
      const throughSet = base ? classifyThroughMembers(rows, base.cpa) : new Set<string>();
      setGeomTypeById(
        new Map(rows.map((r) => [r.globalId, throughSet.has(r.globalId) ? "Continuous" : "Ended"] as const)),
      );

      setManualFlips(new Set());
      setRawRows(rows);
      if (!isSwitch) {
        // Never swap the placeholder while the panel is still opening.
        await screenSwitchRef.current.done;
        if (screenRef.current === "loading") fillPanelBody(bodyRef.current, () => setScreen("results"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A switch-triggered re-extract (rawRows was non-null) that throws must
      // also NOT leave the old-mode table standing — clear it to an empty
      // results screen with the error, same as the 0-rows case above. On the
      // FIRST extract rawRows is already null: back to selection with the error.
      if (rawRows !== null) {
        clearMemberVectors(worldRef.current);
        setBearingSuggestion(null);
        setGeomTypeById(new Map());
        setManualFlips(new Set());
        setRawRows([]);
      } else {
        void switchScreen(selectionWidth, () => setScreen("selection"));
      }
    } finally {
      setExtracting(false);
    }
  }, [members, memberRefs, components, worldRef, getIfcSources, loadedModelIds, ifcSource, rawRows, switchScreen, selectionWidth, resultsWidth]);

  /** Results-screen Tekla/Autodesk switch: updates the persisted setting AND
   * immediately re-extracts the same selection with it — lets the user try
   * the other centerline-extraction path without leaving the results screen
   * or re-picking members. Clicking the ALREADY-active mode is a no-op:
   * re-running the same extraction is deterministic (same result) and only
   * risks disturbing the isolation/selection, so ignore it. */
  const handleSwitchSource = useCallback(
    (v: "tekla" | "autodesk") => {
      if (v === ifcSource || extracting) return;
      setIfcSource(v);
      void handleExtract(v);
    },
    [ifcSource, extracting, setIfcSource, handleExtract],
  );

  const handleSaveConnection = useCallback(() => {
    if (!rawRows || !ifcName) return;
    const defaultName = `Connection ${savedConnections.length + 1}`;
    const name = window.prompt("Enter connection name:", defaultName);
    if (!name) return;
    const newConn: SavedConnection = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      rawRows,
      bearingGlobalId,
      geomTypeById: Array.from(geomTypeById.entries()),
      manualFlips: Array.from(manualFlips),
      memberRefs: Array.from(memberRefs.entries()),
      ifcSource,
      // Remember the exact camera vantage so re-selecting this connection
      // returns to it (see handleSelectConnection). Undefined if unavailable.
      camera: captureViewpoint(worldRef.current) ?? undefined,
    };
    // The store returns the list it stored, so the panel never has to re-read
    // to find out what it just wrote.
    void saveConnection(ifcName, newConn).then(setSavedConnections);
  }, [rawRows, ifcName, savedConnections, bearingGlobalId, geomTypeById, manualFlips, memberRefs, ifcSource, worldRef]);

  const handleRemoveConnection = useCallback((id: string) => {
    if (!ifcName) return;
    void removeConnection(ifcName, id).then(setSavedConnections);
  }, [ifcName]);

  const handleRenameConnection = useCallback((id: string, currentName: string) => {
    if (!ifcName) return;
    const newName = window.prompt("Enter new connection name:", currentName);
    if (!newName || newName === currentName) return;
    void renameConnection(ifcName, id, newName).then(setSavedConnections);
  }, [ifcName]);

  const handleExportLibrary = useCallback((selectedIds: string[]) => {
    if (!ifcName || selectedIds.length === 0) return;
    requireSurface();
    const connectionsToExport = savedConnections.filter((c) => selectedIds.includes(c.id));

    const workbook = XLSX.utils.book_new();

    connectionsToExport.forEach((conn, index) => {
      const inputs = conn.rawRows.map((r) => ({
        globalId: r.globalId,
        start: r.start,
        end: r.end,
        unit: r.unit,
        tangentStart: r.tangentStart,
        tangentEnd: r.tangentEnd,
        curve: r.curve,
      }));
      const bearingId = conn.bearingGlobalId ?? conn.rawRows[0]?.globalId ?? null;
      const base = solveJoint(inputs);
      const geomTypeMap = new Map(conn.geomTypeById);
      const endedCloseEnds = base
        ? base.members
            .filter((s) => s.globalId !== bearingId && geomTypeMap.get(s.globalId) === "Ended")
            .map((s) => s.close)
        : [];
      const js = anchorNodeToBearing(inputs, bearingId, { endedCloseEnds });
      
      const orientedRows = buildOrientedRows(conn.rawRows, js, bearingId, geomTypeMap, new Set(conn.manualFlips));

      const header = [
        "Bearing", "Type", "Class", "Tag", "Profile", "Len",
        "<Rx,Ry,Rz>", "Alfa", "ey", "ez", "Ecc",
        "A", "Iy", "Iz", "Cross-section axes", "Conf.", "Src", "Src_Agreement_mm",
      ];
      const data = orientedRows.map((r) => {
        const rxyz = formatDirectionComponents(r.unit);
        return [
          r.globalId === bearingId ? "yes" : "",
          r.isContinuous ? "Continuous" : "Ended",
          r.ifcClass.replace("Ifc", ""),
          r.tag || "",
          r.profile || "",
          r.length,
          `${rxyz[0]} ${rxyz[1]} ${rxyz[2]}`,
          r.rotationDeg ?? r.rotationIdeaDeg ?? "",
          num(r.offsetLocal[1]), num(r.offsetLocal[2]),
          r.eccentricityMm,
          r.sectionAreaMm2 ?? "", r.iStrongCm4 ?? "", r.iWeakCm4 ?? "",
          `A(${r.crossSectionAxisA.map(num).join(",")}) B(${r.crossSectionAxisB.map(num).join(",")})`,
          r.axisConfidence,
          CENTERLINE_SRC_ABBR[r.centerlineSource] ?? r.centerlineSource,
          r.centerlineAgreementMm ?? "",
        ];
      });
      
      const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
      
      let sheetName = conn.name.substring(0, 31).replace(/[\\/*?:\[\]]/g, "_");
      if (workbook.SheetNames.includes(sheetName)) {
         sheetName = `${sheetName.substring(0, 27)}_${index}`;
      }
      
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    });

    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
    const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Connections_${ifcName.replace(".ifc", "")}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [ifcName, savedConnections]);

  /**
   * Clicking a saved connection re-selects its members and frames the camera on
   * them — it does NOT extract & isolate. The user lands back on the selection
   * screen with the connection's picks restored (in their original order) and
   * presses "Extract & Isolate" when ready, just like a fresh manual selection.
   */
  const handleSelectConnection = useCallback(async (conn: SavedConnection) => {
    const highlighter = components.get(Highlighter);
    if (!highlighter.isSetup) return;

    // Stored refs, used ONLY for the best-effort camera framing below. They are
    // not what the selection is rebuilt from — see the resolve step further down.
    const storedByModel: Record<string, Set<number>> = {};
    for (const [, ref] of conn.memberRefs) {
      (storedByModel[ref.modelId] ??= new Set<number>()).add(ref.localId);
    }

    // Fire the camera move FIRST and independently of the (async) selection
    // work below. This is what makes fast switching smooth: camera-controls
    // retargets an in-flight transition to the newest destination, but only if
    // the newest click's move is the last one dispatched. Gating the move
    // behind each click's clear/highlight/resolve awaits let an earlier click's
    // move fire *after* a later one — the camera lunged to the new connection,
    // then jerked back to the old one. Dispatching synchronously here keeps the
    // moves in click order. Saved-viewpoint connections glide to their vantage;
    // older (viewpoint-less) ones get the top-down fallback (+X to the right).
    if (conn.camera) {
      void applyViewpoint(worldRef.current, conn.camera);
    } else {
      // Best-effort: frames nothing (silently) if the stored modelIds are stale.
      // It's a camera nicety, not correctness, so it stays on the fast path.
      void frameMembersTopDown(components, worldRef.current, storedByModel);
    }

    // Resolve by GlobalId across EVERY loaded model instead of trusting the
    // stored modelId. A saved record outlives the exact model it was saved
    // against: the file can be unmounted and re-imported (which issues a NEW
    // modelId — see `uniqueModelId`), or loaded in a different order. Keying the
    // restore on the stored modelId made all of those resolve to nothing and the
    // connection came back silently SHORT — a joint missing members, with the
    // table and every export looking perfectly normal. GlobalId is stable across
    // files by definition, so it is the right key here.
    const resolved = await Promise.all(
      conn.memberRefs.map(
        async ([globalId]) => [globalId, await resolveMemberByGlobalIdAnyModel(components, globalId)] as const,
      ),
    );
    // Stored member order preserved — the event-derived selection list would
    // otherwise be reordered by whatever happened to be selected before.
    const ordered = resolved.map(([, m]) => m).filter((m): m is SelectedMember => Boolean(m));
    const missing = resolved.length - ordered.length;

    // Replace the selection with just this connection's members. removePrevious
    // (3rd arg) already clears the old selection, so there is no separate
    // clear() — that was a second selection-mesh rebuild per click, adding to
    // the stutter. Suppress the highlighter's own zoom (4th arg) — we drive the
    // camera above.
    const byModel: Record<string, Set<number>> = {};
    for (const m of ordered) (byModel[m.modelId] ??= new Set<number>()).add(m.localId);
    if (Object.keys(byModel).length > 0) {
      await highlighter.highlightByID("select", byModel, true, false);
    } else {
      await highlighter.clear("select");
    }
    setMembers(ordered);
    // Say it rather than restore a short joint quietly.
    setError(
      missing > 0
        ? `${missing} member(s) of this joint were not found in the loaded files — import the IFC they belong to.`
        : null,
    );
  }, [components, worldRef, setMembers]);

  const handleExportLibraryJson = useCallback((selectedIds: string[]) => {
    if (!ifcName || selectedIds.length === 0) return;
    requireSurface();
    const connectionsToExport = savedConnections.filter((c) => selectedIds.includes(c.id));
    try {
      const dataStr = JSON.stringify(connectionsToExport, null, 2);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `connections_${ifcName.replace(/\.[^/.]+$/, "")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export JSON failed:", err);
      alert("Failed to export JSON.");
    }
  }, [ifcName, savedConnections]);

  const handleImportLibraryJson = useCallback((file: File) => {
    if (!ifcName) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = e.target?.result as string;
        const imported = JSON.parse(json) as SavedConnection[];
        if (!Array.isArray(imported)) throw new Error("Invalid format");
        imported.forEach(conn => {
          // Regenerate ID to avoid collisions if we already have it, or keep it?
          // Since it's from the same file, keeping IDs might overwrite, which could be desired.
          // Let's just overwrite existing or append. saveConnection handles updates if id exists.
          saveConnection(ifcName, conn);
        });
        void loadConnections(ifcName).then(setSavedConnections);
        alert(`Imported ${imported.length} connections successfully.`);
      } catch (err) {
        console.error("Import JSON failed:", err);
        alert("Failed to import JSON. Make sure the file is a valid Connection Library export.");
      }
    };
    reader.readAsText(file);
  }, [ifcName]);

  const handleRestoreConnection = useCallback(async (conn: SavedConnection) => {
    setRawRows(conn.rawRows);
    setBearingGlobalId(conn.bearingGlobalId);
    setGeomTypeById(new Map(conn.geomTypeById));
    setManualFlips(new Set(conn.manualFlips));
    setIfcSource(conn.ifcSource);
    setMemberRefs(new Map(conn.memberRefs));
    onRightPanelVisibilityChange?.(true);
    
    const visibleByModel: Record<string, Set<number>> = {};
    for (const [, ref] of conn.memberRefs) {
      (visibleByModel[ref.modelId] ??= new Set<number>()).add(ref.localId);
    }
    await applyStoreyIsolation(components, worldRef as any, visibleByModel);
    if (worldRef.current) hideExtraneousLines(worldRef.current as any);
    
    const highlighter = components.get(Highlighter);
    if (highlighter.isSetup) await highlighter.clear("red-highlight");
  }, [components, worldRef, onRightPanelVisibilityChange]);

  const handleOpenIdeaDesign = useCallback(async (conn: SavedConnection) => {
    // 1. Restore it visually
    await handleRestoreConnection(conn);
    
    // 2. Compute the exact same inputs we would on the results screen
    const inputs = conn.rawRows.map((r) => ({
      globalId: r.globalId,
      start: r.start,
      end: r.end,
      unit: r.unit,
      tangentStart: r.tangentStart,
      tangentEnd: r.tangentEnd,
      curve: r.curve,
    }));
    const bearingId = conn.bearingGlobalId ?? conn.rawRows[0]?.globalId ?? null;
    const base = solveJoint(inputs);
    const geomTypeMap = new Map(conn.geomTypeById);
    const endedCloseEnds = base
      ? base.members
          .filter((s) => s.globalId !== bearingId && geomTypeMap.get(s.globalId) === "Ended")
          .map((s) => s.close)
      : [];
    const js = anchorNodeToBearing(inputs, bearingId, { endedCloseEnds });
    const orientedRows = buildOrientedRows(conn.rawRows, js, bearingId, geomTypeMap, new Set(conn.manualFlips));
    
    const nodeMm = js?.node;
    const continuousIds = new Set(
      Array.from(geomTypeMap.entries())
        .filter(([, type]) => type === "Continuous")
        .map(([id]) => id)
    );
    
    const xml = emitConnectionIom(orientedRows, bearingId, continuousIds, {
      nodeMm: nodeMm ?? undefined,
    });
    
    // 3. Open the Idea Design panel
    onOpenConnectionDesign?.(orientedRows, xml, nodeMm ?? null);
  }, [handleRestoreConnection, onOpenConnectionDesign]);

  const handleShowAllConnections = useCallback(async () => {
    if (!worldRef.current) return;
    await clearStoreyIsolation(components, worldRef as any);
    restoreExtraneousLines(worldRef.current);
    
    const highlighter = components.get(Highlighter);
    if (!highlighter.isSetup) return;
    
    if (!highlighter.styles.has("red-highlight")) {
      highlighter.styles.set("red-highlight", {
        color: new THREE.Color().setHex(0xff0000),
        renderedFaces: 1,
        opacity: 0.5,
        transparent: true,
      });
    }
    
    // Saved records can name a modelId that is no longer loaded (file unmounted,
    // or re-imported under a fresh id) — drop those rather than handing the
    // highlighter a dead model. This is a visual overview, so a record whose file
    // is absent simply doesn't light up; correctness-critical restore goes through
    // handleSelectConnection, which resolves by GlobalId instead.
    const loaded = new Set(loadedModelIds);
    const combinedByModel: Record<string, Set<number>> = {};
    for (const conn of savedConnections) {
      for (const [, ref] of conn.memberRefs) {
        if (!loaded.has(ref.modelId)) continue;
        (combinedByModel[ref.modelId] ??= new Set<number>()).add(ref.localId);
      }
    }
    if (Object.keys(combinedByModel).length === 0) return;

    await highlighter.highlightByID("red-highlight", combinedByModel, false, false);
    
    const boundingBoxer = components.get(BoundingBoxer);
    try {
      boundingBoxer.list.clear();
      await boundingBoxer.addFromModelIdMap(combinedByModel);
      const box = boundingBoxer.get();
      boundingBoxer.list.clear();
      if (box && !box.isEmpty?.() && worldRef.current.camera.controls) {
        const size = box.getSize(new THREE.Vector3());
        const pad = Math.max(size.x, size.y, size.z, 1) * 0.6;
        await worldRef.current.camera.controls.fitToBox(box, true, {
          paddingLeft: pad, paddingRight: pad, paddingTop: pad, paddingBottom: pad
        });
      }
    } catch (e) {
      boundingBoxer.list.clear();
    }
  }, [components, worldRef, savedConnections, loadedModelIds]);

  const backToSelection = useCallback(async () => {
    setError(null);
    setMissingInfo(null);
    setBearingSuggestion(null);
    setFullscreen(false);
    clearMemberVectors(worldRef.current);
    restoreExtraneousLines(worldRef.current);
    // `rawRows` is dropped in the swap, once the results have faded out — and
    // the swap clears the vectors again: anything that re-derives the rows in
    // those 200 ms (the unmount reconcile below resets bearing/type/flips)
    // redraws them.
    void switchScreen(selectionWidth, () => {
      setRawRows(null);
      setScreen("selection");
      clearMemberVectors(worldRef.current);
    });
    await clearStoreyIsolation(components, worldRef as any);
  }, [components, worldRef, switchScreen, selectionWidth]);

  /**
   * Reconcile every piece of per-member state against the files that are
   * actually loaded. Runs whenever the loaded set changes — a file taken out
   * ("unmount"), replaced, or added.
   *
   * This is not tidying, it is the difference between a wrong answer and no
   * answer. `memberRefs` is the ONLY place the results screen still records which
   * file each member came from (`MemberVectorRow` carries `globalId` alone), and
   * it is where a Tekla/Autodesk re-extract takes its targets from. Left unpruned
   * after a file is unmounted, that re-extract routes the removed file's members
   * at a buffer that no longer exists; `extractMemberVectorsAcrossModels` skips
   * them, and `solveJoint`/`anchorNodeToBearing` then re-solve the joint from the
   * SURVIVORS — relocating the node and changing every ey/ez/Ecc — while the
   * on-screen warning blames missing Axis/mesh geometry. So results that depended
   * on the removed file are torn down rather than quietly re-solved on a
   * different set of members than the user picked.
   */
  useEffect(() => {
    const loaded = new Set(loadedModelIds);
    const survivors = members.filter((m) => loaded.has(m.modelId));
    const refsWentStale = Array.from(memberRefs.values()).some((r) => !loaded.has(r.modelId));
    if (survivors.length === members.length && !refsWentStale) return;

    if (refsWentStale) {
      setMemberRefs((prev) => new Map(Array.from(prev).filter(([, r]) => loaded.has(r.modelId))));
      if (rawRows !== null) {
        void backToSelection();
        // Also the globalId-keyed results state: `backToSelection` leaves these
        // alone (a normal back-navigation keeps the user's bearing pick), but
        // here the ids themselves may belong to the file that just went away.
        setBearingGlobalId(null);
        setGeomTypeById(new Map());
        setManualFlips(new Set());
        setError(
          "Members of the removed file were in the results; the results were cleared. " +
            "Re-run extraction with the remaining selection.",
        );
      }
    }

    if (survivors.length !== members.length) {
      setMembers(survivors);
      // Re-assert the Highlighter's own selection map from the survivors:
      // nothing clears it when a model is disposed, so it would keep holding the
      // dead modelId. Re-asserting (rather than clearing outright) keeps the
      // picks the user made in the files that are still open.
      const highlighter = components.get(Highlighter);
      if (highlighter.isSetup) {
        const byModel: Record<string, Set<number>> = {};
        for (const m of survivors) (byModel[m.modelId] ??= new Set<number>()).add(m.localId);
        const settle = Object.keys(byModel).length > 0
          ? highlighter.highlightByID("select", byModel, true, false)
          : highlighter.clear("select");
        void Promise.resolve(settle)
          .then(() => {
            if (worldRef.current?.renderer) worldRef.current.renderer.needsUpdate = true;
          })
          .catch(() => undefined);
      }
    }
  }, [loadedModelIds, members, memberRefs, rawRows, components, worldRef, setMembers, backToSelection]);

  const handleClose = useCallback(async () => {
    setFullscreen(false);
    clearMemberVectors(worldRef.current);
    restoreExtraneousLines(worldRef.current);

    if (rawRows !== null) {
      // ✕ on the RESULTS screen returns to the pre-Extract&Isolate state:
      // un-isolated, members still red and in the selection list. The panel
      // narrows shut (content not faded) on the same frame the model starts
      // fading back in, and switches to the selection screen behind the
      // collapsed strip. Re-assert the full extract selection (clicking a
      // results row may have narrowed the live highlight to a single member) —
      // BEFORE the fade-in: the fade leaves only select-highlighted members
      // opaque, so a joint member the narrowed highlight had dropped would blink
      // out and fade back in with the rest.
      abortScreenSwitch();
      let collapsing: Promise<void> | null = null;
      const startCollapse = () => {
        collapsing ??= shellRef.current?.collapse(PANEL_COLLAPSE_MS, PANEL_MOVE_EASE) ?? Promise.resolve();
      };
      const byModel: Record<string, Set<number>> = {};
      for (const [, ref] of memberRefs) (byModel[ref.modelId] ??= new Set<number>()).add(ref.localId);
      if (Object.keys(byModel).length > 0) {
        const highlighter = components.get(Highlighter);
        // Re-painting is a full Highlighter reset + repaint (~0.5 s measured on
        // the bundled roof model) that would sit between the ✕ and the fade, so
        // skip it when the live selection already is exactly the joint.
        const live = highlighter.isSetup ? highlighter.selection.select ?? {} : {};
        const liveMatches =
          Object.keys(live).every((mid) => (live[mid]?.size ?? 0) === 0 || byModel[mid]) &&
          Object.entries(byModel).every(
            ([mid, ids]) => live[mid]?.size === ids.size && [...ids].every((id) => live[mid].has(id)),
          );
        if (highlighter.isSetup && !liveMatches) {
          await highlighter.highlightByID("select", byModel, true, false);
          if (worldRef.current?.renderer) worldRef.current.renderer.needsUpdate = true;
        }
      }
      // Un-isolate; keeps the red highlight. The rest of the model fades back in.
      await clearStoreyIsolation(components, worldRef as any, {
        transitionMs: ISOLATION_TRANSITION_MS,
        onFadeStart: startCollapse,
      });
      startCollapse(); // no fade ran (nothing to animate) — still close the panel
      await collapsing;
      setScreen("selection");
      shellRef.current?.setWidth(selectionWidth);
      setRawRows(null);
      setError(null);
      setMissingInfo(null);
      return;
    }

    // ✕ on the SELECTION screen closes the whole panel (the red highlight is
    // left untouched in the viewer). Nothing is isolated here, so no fade —
    // fading an already-visible model would dip it to transparent and back.
    await clearStoreyIsolation(components, worldRef as any);
    setError(null);
    setMissingInfo(null);
    onClose();
  }, [components, worldRef, memberRefs, rawRows, onClose, abortScreenSwitch, selectionWidth]);

  const copyTsv = useCallback(() => {
    if (!orientedRows) return;
    navigator.clipboard
      .writeText(toCsv(orientedRows, jointSolution?.node ?? null).replace(/,/g, "\t"))
      .catch(() => undefined);
  }, [orientedRows, jointSolution]);

  const downloadCsv = useCallback(() => {
    if (!orientedRows) return;
    const blob = new Blob([toCsv(orientedRows, jointSolution?.node ?? null)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "member-vectors.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [orientedRows, jointSolution]);

  const downloadTableXlsx = useCallback(() => {
    if (!orientedRows) return;
    const bytes = toTableXlsx(orientedRows, bearingGlobalId ?? orientedRows[0]?.globalId ?? null);
    const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "member-vectors-table.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }, [orientedRows, bearingGlobalId]);

  const [ideaConBusy, setIdeaConBusy] = useState(false);
  // Only a failure is kept (shown as the button's tooltip): the busy state is the
  // button itself, and a success is the browser's own download.
  const [ideaConError, setIdeaConError] = useState<string | null>(null);

  // Export .ideaCon: POST the container IOM to the dev-only bridge
  // (idea-bridge-server.mts), which runs tools/idea/iom_to_ideacon.py against the
  // IDEA StatiCa REST service and returns a design-ready .ideaCon. Everything
  // stays on this machine — no upload anywhere.
  const downloadIdeaCon = useCallback(async () => {
    if (!orientedRows || orientedRows.length === 0) return;
    const bearingId = bearingGlobalId ?? orientedRows[0].globalId;
    const continuousIds = new Set(orientedRows.filter((r) => r.isContinuous).map((r) => r.globalId));
    const xml = emitConnectionIom(orientedRows, bearingId, continuousIds, { nodeMm: jointSolution?.node });
    const bearingRow = orientedRows.find((r) => r.globalId === bearingId);
    const name = String(bearingRow?.tag || bearingRow?.name || "connection").slice(0, 60);
    setIdeaConBusy(true);
    setIdeaConError(null);
    const fail = (error: string) => {
      console.error("[iom_to_ideacon] " + error);
      setIdeaConError("✗ " + error);
    };
    try {
      const resp = await fetch(`/api/idea/ideacon?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      });
      const data = await resp.json();
      if (data.report) console.log("[iom_to_ideacon]\n" + data.report);
      if (!data.ok) {
        fail(data.error || "conversion failed (see console). Is the IDEA REST service running?");
        return;
      }
      const bytes = Uint8Array.from(atob(data.ideaConBase64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename || `${name}.ideaCon`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fail("bridge error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIdeaConBusy(false);
    }
  }, [orientedRows, bearingGlobalId, jointSolution]);

  const downloadIom = useCallback(() => {
    if (!orientedRows || orientedRows.length === 0) return;
    const continuousIds = new Set(orientedRows.filter((r) => r.isContinuous).map((r) => r.globalId));
    const xml = emitConnectionIom(orientedRows, bearingGlobalId ?? orientedRows[0].globalId, continuousIds, {
      nodeMm: jointSolution?.node,
    });
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "connection-iom.xml";
    a.click();
    URL.revokeObjectURL(url);
  }, [orientedRows, bearingGlobalId, jointSolution]);

  const downloadIomForGh = useCallback(() => {
    if (!orientedRows || orientedRows.length === 0) return;
    const continuousIds = new Set(orientedRows.filter((r) => r.isContinuous).map((r) => r.globalId));
    const xml = emitConnectionIom(orientedRows, bearingGlobalId ?? orientedRows[0].globalId, continuousIds, {
      nodeMm: jointSolution?.node,
      bareOpenModel: true,
      keepGlobalCoordinates: true,
      markBearingName: true,
    });
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "connection-iom-gh.xml";
    a.click();
    URL.revokeObjectURL(url);
  }, [orientedRows, bearingGlobalId, jointSolution]);

  if (!isOpen || !isIfcLoaderSetupCompleted) return null;

  const body = (
    // Clip wrapper for panel-motion.ts: while a screen switch holds the content
    // at a fixed width, it cuts off the overhang instead of growing a scrollbar.
    <div>
      <div ref={bodyRef} className="flex flex-col gap-3 px-2 pb-4 text-text-primary">
        {screen === "selection" ? (
          <SelectionView
            members={members}
            memberProfiles={memberProfiles}
            removeMember={removeMember}
            onExtract={handleExtract}
            extracting={extracting}
            error={error}
            tagQuery={tagQuery}
            setTagQuery={setTagQuery}
            onGoToTag={handleGoToTag}
            tagSearching={tagSearching}
            tagSearchError={tagSearchError}
          />
        ) : screen === "loading" || !rawRows ? (
          <ResultsSkeleton />
        ) : (
          <ResultsView
            rows={orientedRows ?? []}
            ifcSource={ifcSource}
            onSwitchSource={handleSwitchSource}
            switching={extracting}
            switchError={error}
            missingInfo={missingInfo}
            selectedGlobalIds={selectedGlobalIds}
            onSelectRow={handleSelectRow}
            node={jointSolution?.node ?? null}
            bearingOffsetMm={jointSolution?.bearingOffsetMm ?? null}
            bearingGlobalId={bearingGlobalId ?? rawRows[0]?.globalId ?? null}
            setBearingGlobalId={setBearingGlobalId}
            setGeomType={(gid, type) =>
              setGeomTypeById((prev) => {
                const next = new Map(prev);
                next.set(gid, type);
                return next;
              })
            }
            bearingSuggestion={bearingSuggestion}
            toggleFlip={(gid) =>
              setManualFlips((prev) => {
                const next = new Set(prev);
                if (next.has(gid)) next.delete(gid);
                else next.add(gid);
                return next;
              })
            }
            onBack={backToSelection}
            onCopy={copyTsv}
            onDownload={downloadCsv}
            onDownloadTableXlsx={downloadTableXlsx}
            onDownloadIom={downloadIom}
            onDownloadIdeaCon={downloadIdeaCon}
            ideaConBusy={ideaConBusy}
            ideaConError={ideaConError}
            onDownloadIomForGh={downloadIomForGh}
            onSaveConnection={handleSaveConnection}
            isFullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
            onOpenConnectionDesign={onOpenConnectionDesign ? () => {
              if (!orientedRows || orientedRows.length === 0) return;
              const continuousIds = new Set(orientedRows.filter((r) => r.isContinuous).map((r) => r.globalId));
              const nodeMm = jointSolution?.node ?? null;
              const xml = emitConnectionIom(orientedRows, bearingGlobalId ?? orientedRows[0].globalId, continuousIds, {
                nodeMm: nodeMm ?? undefined,
              });
              onOpenConnectionDesign(orientedRows, xml, nodeMm);
            } : undefined}
                    />
        )}
      </div>
    </div>
  );

  // Fullscreen results: escape the narrow right panel so the wide table + diagram
  // are all visible on one screen without horizontal scrolling.
  if (fullscreen && rawRows) {
    return (
      <div className="fixed inset-0 z-[60] bg-bg-primary overflow-auto">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-primary sticky top-0 bg-bg-primary z-10">
          <span className="text-sm font-semibold text-text-primary">Member Vectors</span>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 hover:bg-bg-secondary text-text-secondary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {body}
      </div>
    );
  }

  // Selection and results screens want very different widths: the selection
  // list is narrow, but the results table + joint diagram need room. ONE shell
  // for both — a screen switch moves its width (panel-motion.ts). It used to be
  // re-keyed per screen to re-seed the width, and every remount came up
  // collapsed: the "panel shuts on Extract" the user saw was that, not a choice.
  const resultsLike = screen !== "selection";
  return (
    <>
      {isOpen && isIfcLoaderSetupCompleted && (
        <ConnectionLibraryPanel
          connections={savedConnections}
          onSelect={handleSelectConnection}
          onRemove={handleRemoveConnection}
          onRename={handleRenameConnection}
          onOpenIdeaDesign={handleOpenIdeaDesign}
          onShowAll={handleShowAllConnections}
          onExportLibrary={handleExportLibrary}
          onExportLibraryJson={handleExportLibraryJson}
          onImportLibraryJson={handleImportLibraryJson}
          onWidthChange={onLibraryPanelWidthChange}
        />
      )}
      {isRightPanelVisible && (
        <RightPanelShell
          ref={shellRef}
          title="Member Vectors"
          onClose={handleClose}
          resizable
          minWidth={resultsLike ? (resultsMinWidth ?? 280) : (selectionMinWidth ?? 200)}
          defaultWidth={resultsLike ? resultsWidth : selectionWidth}
          maxWidth={resultsLike ? (resultsMaxWidth ?? 1800) : (selectionMaxWidth ?? 520)}
          // Results panel: dragging narrower than minWidth snaps back to the
          // compact default instead of collapsing (see usePanelResize).
          snapBackToDefault={resultsLike}
          onWidthChange={onPanelWidthChange}
        >
          {body}
        </RightPanelShell>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Selection sub-view
// ---------------------------------------------------------------------------

interface SelectionViewProps {
  members: SelectedMember[];
  /** GlobalId → profile name, resolved lazily; absent entries fall back to index-only labels. */
  memberProfiles: Map<string, string>;
  removeMember: (globalId: string) => void;
  onExtract: () => void;
  extracting: boolean;
  error: string | null;
  tagQuery: string;
  setTagQuery: (v: string) => void;
  onGoToTag: () => void;
  tagSearching: boolean;
  tagSearchError: string | null;
}

const SelectionView = ({
  members,
  memberProfiles,
  removeMember,
  onExtract,
  extracting,
  error,
  tagQuery,
  setTagQuery,
  onGoToTag,
  tagSearching,
  tagSearchError,
}: SelectionViewProps) => (
  <>
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={tagQuery}
        onChange={(e) => setTagQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onGoToTag();
        }}
        placeholder="Elemana git (Tag veya GUID)…"
        className="flex-grow rounded-lg border border-border-primary px-2 py-1 text-xs bg-bg-primary"
      />
      <Button
        loading={tagSearching}
        disabled={!tagQuery.trim() || tagSearching}
        onClick={onGoToTag}
        className="text-xs px-2 py-1"
      >
        Git
      </Button>
    </div>
    {tagSearchError ? <p className="text-xs text-red-400">{tagSearchError}</p> : null}

    {members.length === 0 ? (
      <p className="text-sm text-text-secondary py-4 text-center">No members selected.</p>
    ) : (
      <ul className="flex flex-col gap-1">
        {members.map((m, i) => (
          <li
            key={`${m.modelId}:${m.localId}`}
            className="flex items-center gap-2 rounded-lg border border-border-primary px-2 py-1.5 text-xs"
          >
            <div className="flex flex-col min-w-0 flex-grow">
              <span className="font-medium truncate" title={m.globalId}>
                {memberProfiles.get(m.globalId) ? `(${i + 1}) ${memberProfiles.get(m.globalId)}` : `(${i + 1})`}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="px-1 hover:text-text-link" onClick={() => removeMember(m.globalId)} aria-label="Remove">✕</button>
            </div>
          </li>
        ))}
      </ul>
    )}

    {error ? <p className="text-xs text-red-400">{error}</p> : null}

    <Button fullWidth loading={extracting} disabled={members.length === 0 || extracting} onClick={onExtract} className="text-sm">
      Extract &amp; Isolate ({members.length})
    </Button>
  </>
);

/**
 * The results screen while extraction runs — the panel opens onto this during
 * the 3D isolation, and the rows replace it (panel-motion.ts). `animate-pulse`
 * is an opacity animation, so it keeps beating through the main-thread block
 * extraction causes.
 */
const ResultsSkeleton = () => (
  <div className="flex flex-col gap-3" aria-busy="true">
    {/* Clipped: a placeholder must not add a scrollbar the panel didn't have. */}
    <div className="flex items-center gap-2 overflow-hidden">
      {[76, 72, 92, 118, 112, 96].map((w, i) => (
        <div key={i} className="h-6 shrink-0 rounded bg-bg-secondary animate-pulse" style={{ width: w }} />
      ))}
    </div>
    <p className="text-xs text-text-secondary">Extracting…</p>
    <div className="h-16 rounded-md bg-bg-secondary animate-pulse" />
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="h-5 rounded bg-bg-secondary animate-pulse" />
      ))}
    </div>
  </div>
);

/**
 * Tekla/Autodesk centerline-extraction-path switch. Lives ONLY on the results
 * screen (not the selection screen) — the point is to try a path, SEE the
 * result (or the error/eccentricities it produces), and switch to the other
 * one right there if it didn't work, without re-picking the member selection.
 */
const SourceToggle = ({
  value,
  onChange,
  disabled,
}: {
  value: "tekla" | "autodesk";
  onChange: (v: "tekla" | "autodesk") => void;
  disabled: boolean;
}) => (
  <div className="flex items-center gap-1 rounded-lg border border-border-primary p-0.5" role="radiogroup" aria-label="IFC export source">
    <button
      type="button"
      role="radio"
      aria-checked={value === "autodesk"}
      onClick={() => onChange("autodesk")}
      disabled={disabled}
      title="Original extraction path (Axis/FootPrint + parametric extrusion) — no changes"
      className={`rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
        value === "autodesk" ? "bg-bg-primary font-medium text-text-primary" : "text-text-secondary hover:text-text-primary"
      }`}
    >
      Autodesk
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={value === "tekla"}
      onClick={() => onChange("tekla")}
      disabled={disabled}
      title="Adds a Brep-mesh PCA centerline fallback for members with no Axis/extrusion representation"
      className={`rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
        value === "tekla" ? "bg-bg-primary font-medium text-text-primary" : "text-text-secondary hover:text-text-primary"
      }`}
    >
      Tekla
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Results sub-view
// ---------------------------------------------------------------------------

interface ResultsViewProps {
  rows: OrientedMemberVectorRow[];
  ifcSource: "tekla" | "autodesk";
  /** Re-extracts the SAME selection with the newly picked source — no need to leave this screen or re-pick members. */
  onSwitchSource: (v: "tekla" | "autodesk") => void;
  /** True while a switch-triggered re-extract is in flight (disables the toggle so it can't be re-fired mid-request). */
  switching: boolean;
  /** Error from the most recent extract attempt (including a failed switch) — the previous table stays visible underneath it. */
  switchError: string | null;
  /**
   * Requested members that came back with no resolvable centerline in the
   * mode just used. `suggestTekla` is true only in Autodesk mode — a miss
   * there always means the member has no Axis/parametric-body representation
   * at all, exactly the gap the Tekla mesh-PCA fallback is for.
   */
  missingInfo: { count: number; suggestTekla: boolean } | null;
  /** GlobalIds currently selected in the viewer (ctrl+click multi-select included); highlights their table rows. */
  selectedGlobalIds: Set<string>;
  /** Selects a row's member in the (isolated) viewer — reverse direction of `selectedGlobalIds`. */
  onSelectRow: (globalId: string) => void;
  node: Vec3 | null;
  /** Perpendicular gap (mm) between the attached-member crossing and the bearing axis. */
  bearingOffsetMm: number | null;
  bearingGlobalId: string | null;
  setBearingGlobalId: (id: string) => void;
  /** Per-member geometrical type override (Continuous/Ended); auto-classified at extract, editable per row. */
  setGeomType: (globalId: string, type: "Continuous" | "Ended") => void;
  bearingSuggestion: BearingSuggestion | null;
  toggleFlip: (globalId: string) => void;
  onBack: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onDownloadTableXlsx: () => void;
  onDownloadIom: () => void;
  onDownloadIdeaCon: () => void;
  ideaConBusy?: boolean;
  ideaConError?: string | null;
  onDownloadIomForGh: () => void;
  onSaveConnection: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenConnectionDesign?: () => void;
}

const ResultsView = ({
  rows,
  ifcSource,
  onSwitchSource,
  switching,
  switchError,
  missingInfo,
  selectedGlobalIds,
  onSelectRow,
  node,
  bearingOffsetMm,
  bearingGlobalId,
  setBearingGlobalId,
  setGeomType,
  bearingSuggestion,
  toggleFlip,
  onBack,
  onCopy,
  onDownload,
  onDownloadTableXlsx,
  onDownloadIom,
  onDownloadIdeaCon,
  ideaConBusy,
  ideaConError,
  onDownloadIomForGh,
  onSaveConnection,
  isFullscreen,
  onToggleFullscreen,
  onOpenConnectionDesign,
}: ResultsViewProps) => {
  const suggestedTag = bearingSuggestion
    ? rows.find((r) => r.globalId === bearingSuggestion.globalId)?.tag ?? null
    : null;
  return (
  <>
    <div className="flex items-center gap-2">
      <Button variant="secondary" pressFeedback onClick={onBack} className="text-xs !px-2 !py-1 border border-border-primary">← Selection</Button>
      <Button variant="secondary" pressFeedback onClick={onCopy} className="text-xs !px-2 !py-1 border border-border-primary">Copy (TSV)</Button>
      <Button variant="secondary" pressFeedback onClick={onDownload} className="text-xs !px-2 !py-1 border border-border-primary">Download CSV</Button>
      <Button variant="secondary" pressFeedback onClick={onDownloadTableXlsx} className="text-xs !px-2 !py-1 border border-border-primary" title="Exports the table below exactly as shown (18 columns) as a .xlsx file">Export Table (.xlsx)</Button>
      <Button variant="secondary" pressFeedback onClick={onDownloadIom} className="text-xs !px-2 !py-1 border border-border-primary" title="Geometry-only IDEA Open Model XML — import via IDEA Checkbot (Windows)">Export IDEA (.xml)</Button>
      <Button variant="secondary" pressFeedback onClick={onDownloadIdeaCon} disabled={ideaConBusy} className="text-xs !px-2 !py-1 border border-border-primary bg-brand-primary text-white" title={ideaConError ?? "Convert to a design-ready .ideaCon via the local bridge (needs the IDEA StatiCa REST service on :5000). No cloud upload."}>Export .ideaCon</Button>
      <Button variant="secondary" pressFeedback onClick={onDownloadIomForGh} className="text-xs !px-2 !py-1 border border-border-primary" title="Bare OpenModel XML without container wrapper — direct import for Grasshopper API">IOM for GH</Button>
      <Button variant="secondary" pressFeedback onClick={onSaveConnection} className="text-xs !px-2 !py-1 border border-border-primary bg-brand-primary text-white" title="Save this connection layout to the library">Save Connection</Button>
      {onOpenConnectionDesign && (
        <Button variant="secondary" pressFeedback onClick={onOpenConnectionDesign} className="text-xs !px-2 !py-1 border border-brand-secondary bg-brand-secondary/10 text-brand-secondary hover:bg-brand-secondary hover:text-white" title="Open the connection design assistant — analyse with IDEA StatiCa">🔧 IDEA Design</Button>
      )}
      <SourceToggle value={ifcSource} onChange={onSwitchSource} disabled={switching} />
      <Button variant="secondary" pressFeedback onClick={onToggleFullscreen} className="text-xs !px-2 !py-1 border border-border-primary ml-auto" title="See the whole table and diagram on one screen">
        {isFullscreen ? "⤡ Exit fullscreen" : "⤢ Fullscreen"}
      </Button>
    </div>
    {switchError ? (
      <p className="text-xs text-red-400">{switchError}</p>
    ) : null}
    {!switchError && rows.length > 0 && missingInfo ? (
      <p className="rounded-md border border-amber-500/40 px-2 py-1.5 text-[11px] text-amber-300">
        {missingInfo.count} of {rows.length + missingInfo.count} selected members had no resolvable centerline in{" "}
        {ifcSource === "autodesk" ? "Autodesk" : "Tekla"} mode and were skipped.{" "}
        {missingInfo.suggestTekla
          ? "They have no Axis/parametric-body representation — switch to Tekla below to try the mesh-based fallback for them."
          : "Neither Axis/parametric-body nor the mesh fallback resolved them — likely a real data gap in the IFC."}
      </p>
    ) : null}
    {/* Stays up here while the help text it used to sit in is at the bottom: it
        asks for action, and down there it would go unseen. */}
    {bearingOffsetMm != null && bearingOffsetMm > 25 ? (
      <p className="rounded-md border border-amber-500/40 px-2 py-1.5 text-[11px] text-amber-300">
        ⚠ The bearing member&apos;s axis misses where the other members meet by{" "}
        {Math.round(bearingOffsetMm)} mm. Either a different member is the true bearing member, or this
        is a genuinely eccentric connection — confirm the Bearing pick in the table below.
      </p>
    ) : null}

    {node ? <JointDiagram rows={rows} node={node} bearingGlobalId={bearingGlobalId} /> : null}

    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead className="text-text-secondary">
          <tr className="border-b border-border-primary">
            <th className="p-1 text-left">Bearing</th>
            <th className="p-1 text-left" title="Geometrical type (IDEA): whether this member runs continuously through the joint or terminates at it. Auto-classified; independent of the Bearing pick.">Type</th>
            <th className="p-1 text-left">Class</th>
            <th className="p-1 text-left">Tag</th>
            <th className="p-1 text-left">Profile</th>
            <th className="p-1 text-right">Len</th>
            <th className="p-1 text-right text-amber-300" title="Unit direction vector × 10000, rounded to whole numbers (e.g. Ux=-0.4714 → Rx=-4714) — the same axis direction as ex/Ux/Uy/Uz, just decimal-free.">Rx</th>
            <th className="p-1 text-right text-amber-300" title="Unit direction vector × 10000, rounded to whole numbers">Ry</th>
            <th className="p-1 text-right text-amber-300" title="Unit direction vector × 10000, rounded to whole numbers">Rz</th>
            <th className="p-1 text-right" title="Rotation of the section about the member axis (degrees), IDEA convention. Prefers the IFC pset Cross-Section Rotation (Revit's authored value — verified against IDEA); falls back to the geometric estimate when the pset is absent, flagged with *. The geometric estimate is shown in the tooltip as a cross-check.">Alfa</th>
            <th className="p-1 text-right" title="IDEA offset ey (mm) — cross-section plane (local Y). ex (along-axis) is not computed — IDEA trims the member freely along its own axis.">ey</th>
            <th className="p-1 text-right" title="IDEA offset ez (mm) — cross-section plane (local Z)">ez</th>
            <th className="p-1 text-right" title="Structural eccentricity (mm): perpendicular distance from the node to this member's axis = the moment arm (secondary moment N·e). Amber above 25 mm.">Ecc</th>
            <th className="p-1 text-right" title="Section area (mm²) from the IFC Structural Analysis property">A</th>
            <th className="p-1 text-right" title="Second moment of area, strong axis (cm⁴), from the IFC property">Iy</th>
            <th className="p-1 text-right" title="Second moment of area, weak axis (cm⁴), from the IFC property">Iz</th>
            <th className="p-1 text-left" title="Cross-section axes (global unit vectors) — describes how the profile is rotated about the member length">Cross-section axes</th>
            <th className="p-1 text-right" title="Confidence the length-axis heuristic picked correctly; below 0.98 means the member isn't perfectly straight along the object's local frame">Conf.</th>
            <th className="p-1 text-left" title="Which extraction method produced this centerline (circle/poly/line = Axis curve, extr = body extrusion, mesh = triangulated-Brep PCA). Δ, when shown, is how far the best alternative method's endpoints disagree (mm) — amber above 25 mm.">Src</th>
            <th className="p-1 text-center">Flip</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rxyz = formatDirectionComponents(r.unit);
            const selectionLabel = formatMemberLabel(i, ifcSource, r.globalId, r.tag);
            return (
            <tr
              key={r.globalId}
              onClick={() => onSelectRow(r.globalId)}
              className={`border-b border-border-primary/40 cursor-pointer hover:bg-bg-secondary ${
                selectedGlobalIds.has(r.globalId) ? "bg-brand-primary/10" : ""
              }`}
            >

              <td className="p-1">
                <input
                  type="radio"
                  name="bearing-result"
                  checked={bearingGlobalId === r.globalId}
                  onChange={() => setBearingGlobalId(r.globalId)}
                />
              </td>
              <td className="p-1">
                <select
                  className="rounded border border-border-primary bg-transparent px-1 py-0.5 text-[11px]"
                  value={r.isContinuous ? "Continuous" : "Ended"}
                  onChange={(e) => setGeomType(r.globalId, e.target.value as "Continuous" | "Ended")}
                >
                  <option value="Continuous">Continuous</option>
                  <option value="Ended">Ended</option>
                </select>
              </td>
              <td className="p-1 whitespace-nowrap">{r.ifcClass.replace("Ifc", "")}</td>
              <td className="p-1 whitespace-nowrap" title={r.name}>{selectionLabel}</td>
              <td className="p-1 whitespace-nowrap" title={r.material}>
                {r.profile || "—"}
              </td>
              <td className="p-1 text-right">{r.length}</td>
              <td className="p-1 text-right text-amber-300">{rxyz[0]}</td>
              <td className="p-1 text-right text-amber-300">{rxyz[1]}</td>
              <td className="p-1 text-right text-amber-300">{rxyz[2]}</td>
              <td
                className="p-1 text-right"
                title={`Geometric estimate (cross-check): ${r.rotationIdeaDeg ?? "—"}°${r.rotationDeg == null ? " — no IFC pset, using geometric estimate" : ""}`}
              >
                {r.rotationDeg ?? r.rotationIdeaDeg ?? "—"}
                {r.rotationDeg == null && r.rotationIdeaDeg != null ? "*" : ""}
              </td>
              <td className="p-1 text-right">{num(r.offsetLocal[1])}</td>
              <td className="p-1 text-right">{num(r.offsetLocal[2])}</td>
              <td className={`p-1 text-right ${r.eccentricityMm > 25 ? "text-amber-400" : ""}`} title="Perpendicular eccentricity (moment arm)">
                {r.eccentricityMm}
              </td>
              <td className="p-1 text-right">{r.sectionAreaMm2 ?? "—"}</td>
              <td className="p-1 text-right">{r.iStrongCm4 ?? "—"}</td>
              <td className="p-1 text-right">{r.iWeakCm4 ?? "—"}</td>
              <td className="p-1 whitespace-nowrap font-mono text-[10px]">
                A({r.crossSectionAxisA.map(num).join(",")}) B({r.crossSectionAxisB.map(num).join(",")})
              </td>
              <td className={`p-1 text-right ${r.axisConfidence < 0.98 ? "text-amber-400" : ""}`}>
                {r.axisConfidence}
              </td>
              <td
                className={`p-1 whitespace-nowrap font-mono text-[10px] ${
                  r.centerlineAgreementMm != null && r.centerlineAgreementMm > 25 ? "text-amber-400" : "text-text-secondary"
                }`}
                title={`Centerline method: ${r.centerlineSource}${
                  r.centerlineAgreementMm != null ? ` — best alternative disagrees by ${r.centerlineAgreementMm} mm` : " — only one method applicable"
                }`}
              >
                {CENTERLINE_SRC_ABBR[r.centerlineSource] ?? r.centerlineSource}
                {r.centerlineAgreementMm != null ? ` Δ${r.centerlineAgreementMm}` : ""}
              </td>
              <td className="p-1 text-center">
                <input type="checkbox" checked={r.flipped} onChange={() => toggleFlip(r.globalId)} />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {bearingSuggestion && suggestedTag ? (
      <div
        className={`rounded-md border px-2 py-1.5 text-[11px] ${
          bearingSuggestion.confidence === "high"
            ? "border-brand-primary/40 text-text-primary"
            : "border-amber-500/40 text-amber-300"
        }`}
      >
        <span className="font-medium">
          {bearingSuggestion.confidence === "high" ? "Suggested bearing member: " : "Bearing member unclear — guess: "}
        </span>
        Tag {suggestedTag}. {bearingSuggestion.reason}
        {bearingSuggestion.confidence === "low" ? " (not auto-selected)" : ""}
      </div>
    ) : null}

    <p className="text-[10px] text-text-secondary">
      Coordinates in mm (IFC global). Vectors drawn as cyan arrows in the viewer. Flip reverses a
      member relative to the continuous reference. Cross-section axes (A/B) are the two profile-plane
      directions perpendicular to the member length, as raw global vectors — not yet mapped to any
      specific tool&apos;s rotation-angle convention. A confidence below 0.98 (amber) means the member
      isn&apos;t perfectly straight along its own local frame; treat its cross-section axes as approximate.
    </p>

    {node ? (
      <div className="rounded-md border border-border-primary px-2 py-1.5 text-[11px] text-text-secondary">
        <span className="font-medium text-text-primary">Connection node (mm): </span>
        <span className="font-mono">
          {r3(node[0])}, {r3(node[1])}, {r3(node[2])}
        </span>
        <span className="text-text-tertiary">
          {" "}— on the bearing member&apos;s axis; attached members&apos; offsets are measured from it.
        </span>
      </div>
    ) : null}

    <div className="rounded-md border border-brand-primary/40 bg-brand-primary/5 px-2 py-1.5 text-[11px] text-text-secondary">
      <span className="font-medium text-text-primary">Which member passes through the center node?</span>{" "}
      Pick it with the <span className="font-medium">Bearing</span> radio in the table above — the node snaps
      onto that member&apos;s axis and every other member&apos;s offset (ey/ez) is recomputed against it.
      For an ended bearing member (truss end / support), the node lands where the attached members frame in.
      Each row&apos;s <span className="font-medium">Type</span> (Continuous/Ended) is auto-classified and
      independent of the bearing pick — override it if IDEA&apos;s geometry disagrees.
    </div>
  </>
  );
};

export default MemberVectorsPanel;
