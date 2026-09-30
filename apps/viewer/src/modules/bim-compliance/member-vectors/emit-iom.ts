/**
 * Emit an IDEA StatiCa "IDEA Open Model" (IOM) XML for one connection (joint),
 * geometry-only — no plates/bolts/welds/loads.
 *
 * Structure and element/field ordering mirror a real export from IDEA StatiCa
 * itself (document root <OpenModelContainer><OpenModel>, Version 3.2.0) — the
 * earlier bare <OpenModel>/Version 1 form was rejected by Checkbot's importer
 * before the model was read ("file won't open"). IOM is a flat,
 * integer-Id-referenced XML graph: each object lives once in a typed collection
 * with an <Id>, and is referenced elsewhere by { TypeName, Id }. IOM
 * deserializes as an ordered sequence, so field order within each type matters.
 *
 * Consumption is Windows-side: import the downloaded .xml via IDEA StatiCa
 * Checkbot ("import IOM"), or POST to the local Connection REST API (v24.1+).
 *
 * UNITS: IOM is SI — LENGTH IN METERS (our data is mm → divide by 1000),
 * stress/modulus in Pascals. Right-handed global X/Y/Z.
 *
 * KNOWN UNVERIFIED / LIMITED POINTS — flagged, not guessed:
 *  - Cross-sections are emitted by name only (ParameterString UniqueName), not
 *    with parametric dimensions like IDEA's own export (B/H/s/t… or R/t). When
 *    the IFC has no resolvable profile name the section is "UNKNOWN" and IDEA
 *    cannot build the member — the profile name must be present/resolvable.
 *  - Orientation is pinned by an explicit per-segment LocalCoordinateSystem
 *    (VecX = member axis close→far, VecY = crossSectionAxisA, VecZ = VecX×VecY),
 *    so the CrossSection carries NO rotation. Verified against IDEA's own IOM
 *    export: for correctly-oriented members IDEA's derived VecY==axisA and
 *    VecZ==axisB. Without the LCS, IDEA re-derives the frame from the segment
 *    direction and twists vertical members (columns) by 90°.
 *  - UTF-8 acceptance (IDEA's own export is UTF-16; we emit UTF-8 — standard XML
 *    parsers honor the declared encoding).
 *  - Non-I section CrossSectionType mapping (we default RolledI).
 */

import { solveJoint } from "./joint-solver";
import type { OrientedMemberVectorRow } from "./types";
import { requireSurface } from "./doc-metrics";

type Vec3 = [number, number, number];

/** mm → m, rounded to 6 decimals (µm precision). */
function m(mmValue: number): number {
  return Math.round((mmValue / 1000) * 1e6) / 1e6;
}

/** Escape XML text content / attribute values. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Reference to another IOM object: { TypeName, Id }. */
function ref(typeName: string, id: number): string {
  return `<TypeName>${typeName}</TypeName><Id>${id}</Id>`;
}

/** 3-vector cross product. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Normalize a 3-vector (returns it unchanged if degenerate). */
function normVec(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Snap a unit direction onto a global plane/axis: any component whose magnitude
 * is below `pct`% of the largest component is zeroed, then the vector is
 * renormalized (e.g. <997, 8, 8457> → <0.117, 0, 0.993>). Returns the snapped
 * unit, or null when nothing changed — so callers keep the EXACT original
 * geometry for members that aren't near-axis-aligned.
 */
function snapAxis(u: Vec3, pct: number): Vec3 | null {
  if (pct <= 0) return null;
  const m = Math.max(Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2]));
  if (m === 0) return null;
  const thr = (pct / 100) * m;
  const s: Vec3 = [
    Math.abs(u[0]) < thr ? 0 : u[0],
    Math.abs(u[1]) < thr ? 0 : u[1],
    Math.abs(u[2]) < thr ? 0 : u[2],
  ];
  if (s[0] === u[0] && s[1] === u[1] && s[2] === u[2]) return null; // no change
  const n = Math.hypot(s[0], s[1], s[2]);
  if (n === 0) return null;
  return [s[0] / n, s[1] / n, s[2] / n];
}

/**
 * Coarsen a unit direction: round each component to a grid of `per1000`
 * parts-per-1000 (e.g. per1000 = 1 rounds the ×1000 view to whole numbers, so a
 * −31.8 tilt becomes −32), then renormalize. IDEA re-normalizes the axis to unit
 * anyway, so the tilt (small) components come out clean while the dominant one is
 * pinned by the unit constraint (≈ ±1000). Returns null when nothing changed.
 */
function quantizeAxis(u: Vec3, per1000: number): Vec3 | null {
  if (per1000 <= 0) return null;
  const step = per1000 / 1000;
  const q: Vec3 = [
    Math.round(u[0] / step) * step,
    Math.round(u[1] / step) * step,
    Math.round(u[2] / step) * step,
  ];
  if (q[0] === u[0] && q[1] === u[1] && q[2] === u[2]) return null;
  const n = Math.hypot(q[0], q[1], q[2]);
  if (n === 0) return null;
  return [q[0] / n, q[1] / n, q[2] / n];
}

/**
 * Explicit member Local Coordinate System, pinned to the IFC's actual section
 * frame: VecX = member axis (close→far unit), VecY = a profile-plane axis
 * (crossSectionAxisA), VecZ = VecX×VecY (right-handed, ≈ crossSectionAxisB).
 * Emitted on the LineSegment3D so IDEA orients the section EXACTLY as the model
 * instead of re-deriving a frame from the segment direction (its up-vector
 * convention twists vertical columns 90°). Returns null when axisA is missing or
 * parallel to the axis (then IDEA falls back to its own derivation).
 */
function lcsXml(unit: Vec3, axisA: Vec3, axisSnapPct = 0): string | null {
  // An LCS is a rotation frame, so the three vectors MUST be orthonormal and
  // right-handed. Build by Gram-Schmidt from the axis and one section axis. When
  // axisSnapPct > 0, also snap the in-plane axis onto a global direction if it is
  // near-axis-aligned, then re-orthogonalize — so a nearly axis-aligned member
  // yields a clean axis-aligned frame (big advantage for plate placement).
  const vx = normVec(unit);
  const vzRaw = cross(vx, normVec(axisA));
  const zlen = Math.hypot(vzRaw[0], vzRaw[1], vzRaw[2]);
  if (zlen < 1e-6) return null; // axisA ∥ axis → let IDEA derive the frame
  const vz0: Vec3 = [vzRaw[0] / zlen, vzRaw[1] / zlen, vzRaw[2] / zlen];
  let vy = cross(vz0, vx); // ⟂ vx and vz0, unit, right-handed
  const vySnap = snapAxis(vy, axisSnapPct);
  if (vySnap) {
    // re-orthogonalize the snapped in-plane axis against vx (Gram-Schmidt)
    const d = vySnap[0] * vx[0] + vySnap[1] * vx[1] + vySnap[2] * vx[2];
    vy = normVec([vySnap[0] - d * vx[0], vySnap[1] - d * vx[1], vySnap[2] - d * vx[2]]);
  }
  const vz = cross(vx, vy); // recompute so VecX × VecY = VecZ exactly
  const c6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const vecTag = (name: string, a: Vec3) =>
    `<${name}><X>${c6(a[0])}</X><Y>${c6(a[1])}</Y><Z>${c6(a[2])}</Z></${name}>`;
  return (
    `<LocalCoordinateSystem xsi:type="CoordSystemByVector">` +
    `${vecTag("VecX", vx)}${vecTag("VecY", vy)}${vecTag("VecZ", vz)}` +
    `</LocalCoordinateSystem>`
  );
}

/**
 * Map an IFC/British profile name to an IOM CrossSectionType.
 * POC: only rolled-I families are confirmed (sample uses RolledI/HE200B); other
 * families are defaulted to RolledI and flagged — verify before trusting for
 * hollow/fabricated sections.
 */
function crossSectionType(profile: string): string {
  const p = profile.toUpperCase();
  if (/^(UC|UB|UKC|UKB|UKB|HE|HD|HL|HP|IPE|HEA|HEB|HEM|W|UKBP)/.test(p)) return "RolledI";
  // RHS/SHS/CHS/fabricated fall through — RolledI is a POC placeholder.
  return "RolledI";
}

interface PointRegistry {
  idOf(coordMm: Vec3): number;
  all(): { id: number; x: number; y: number; z: number; name: string }[];
}

/** Dedupe endpoints by coordinate (so a shared joint node is a single Point3D). */
function makePointRegistry(): PointRegistry {
  const byKey = new Map<string, number>();
  const list: { id: number; x: number; y: number; z: number; name: string }[] = [];
  let nextId = 1;
  const key = (c: Vec3) => `${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])}`;
  return {
    idOf(coordMm: Vec3): number {
      const k = key(coordMm);
      const existing = byKey.get(k);
      if (existing != null) return existing;
      const id = nextId++;
      byKey.set(k, id);
      list.push({ id, x: m(coordMm[0]), y: m(coordMm[1]), z: m(coordMm[2]), name: `N${id}` });
      return id;
    },
    all: () => list,
  };
}

/**
 * Maps an IFC profile string (e.g. "UC356x406x744", "UB 203x133x25") to the
 * standard formatting expected by IDEA StatiCa MPRL databases (e.g. "UC 356 x 406 x 744").
 */
function standardizeProfileName(profile: string): string {
  if (!profile) return profile;
  const text = profile.trim();
  // Separate alphabetical prefix from the rest
  const match = text.match(/^([A-Za-z]+)\s*(.*)$/);
  if (match) {
    const prefix = match[1];
    let rest = match[2];
    // Remove existing spaces and ensure 'x' or 'X' are padded with exactly one space
    rest = rest.replace(/ /g, "");
    rest = rest.replace(/x/gi, " x ");
    return `${prefix} ${rest}`;
  }
  return text;
}

export interface IomEmitOptions {
  /** S355 by default; material grade name written to MatSteelEc2.Name. */
  materialName?: string;
  /** ECEN (Eurocode) default. */
  countryCode?: string;
  /** Section-name library table; SCIA matches the official sample. */
  conversionTable?: string;
  projectName?: string;
  /**
   * The connection node in mm (IFC global), as computed by the panel with the
   * bearing member anchored. Pass this so the exported origin matches exactly
   * what the user sees and chose; when omitted the emitter falls back to the
   * plain (democratic) CPA solve, which is WRONG for an ended bearing member.
   */
  nodeMm?: Vec3;
  /**
   * If true, omits the `<OpenModelContainer>` wrapper, exporting a bare `<OpenModel>`.
   * Used for direct API ingestion (e.g. Grasshopper Plugin).
   */
  bareOpenModel?: boolean;
  /**
   * If true, retains the original global coordinates of the joint instead of
   * shifting it to the origin (0,0,0). Crucial for Grasshopper/Rhino alignment.
   */
  keepGlobalCoordinates?: boolean;
  /**
   * If true, appends " [BEARING]" to the name of the bearing member so it can
   * be easily filtered in Grasshopper where the native IsBearingMember flag is
   * not exposed.
   */
  markBearingName?: boolean;
  /**
   * Members whose joint eccentricity is BELOW this many mm are snapped onto the
   * node (their small perpendicular ey/ez offset is removed) so IDEA shows a
   * clean zero-offset joint; genuine, larger eccentricities are preserved.
   * Default 100 mm.
   */
  eccentricitySnapMm?: number;
  /**
   * Axis snap (percent). A component of a member's axial direction whose
   * magnitude is below this % of the largest component is zeroed and the axis
   * renormalized — a nearly axis-aligned member is set exactly onto the global
   * plane/axis (segment redirected, section axes re-adapted), which makes plate
   * placement much easier. Default 1 (%). Set 0 to keep the exact directions.
   */
  axisSnapPct?: number;
  /**
   * Axial-direction coarsening: round each component of a member's axis to a
   * grid of this many parts-per-1000 (the ×1000 IDEA view), so a −31.8 tilt
   * becomes −32. The axis is a UNIT vector (IDEA renormalizes it), so the small
   * tilt components come out clean while the dominant one is pinned near ±1000.
   * Default 1. Set 0 to keep the exact (unrounded) tilt.
   */
  axisRoundPer1000?: number;
}

/**
 * Build the IOM `<OpenModel>` XML string for a single connection from oriented
 * member rows. `bearingGlobalId` marks the single bearing member (the node is
 * anchored to its axis; `IsBearingMember`); `continuousIds` marks, per member,
 * IDEA's Continuous/Ended geometrical type (`IsContinuous`) — the two are
 * orthogonal, a bearing member may itself be Ended.
 */
export function emitConnectionIom(
  rows: OrientedMemberVectorRow[],
  bearingGlobalId: string | null,
  continuousIds: Set<string>,
  opts: IomEmitOptions = {},
): string {
  requireSurface();
  const materialName = opts.materialName ?? "S355";
  const countryCode = opts.countryCode ?? "ECEN";
  const conversionTable = opts.conversionTable ?? "SCIA";
  const projectName = opts.projectName ?? "Member Vectors Connection";
  const eccentricitySnapMm = opts.eccentricitySnapMm ?? 100;
  const axisSnapPct = opts.axisSnapPct ?? 1;
  const axisRoundPer1000 = opts.axisRoundPer1000 ?? 1;

  // Joint node: prefer the bearing-anchored node the panel already computed so
  // the export matches the UI exactly. Fall back to a fresh CPA solve (then the
  // first member's start) only when no node was supplied.
  if (rows.length === 0) throw new Error("emitConnectionIom: rows is empty — nothing to export.");
  const fallback = opts.nodeMm
    ? null
    : solveJoint(rows.map((r) => ({ globalId: r.globalId, start: r.start, end: r.end, unit: r.unit })));
  const nodeMm: Vec3 = opts.nodeMm ?? fallback?.node ?? rows[0].start;
  // Recenter the joint node to the origin: IFC models can carry huge geodetic
  // offsets (this roof is ~632 km from origin), and IDEA connection models are
  // local — keeping coordinates near zero preserves floating-point precision.
  // Grasshopper workflows often require keeping the original global coordinates.
  const keepGlobal = opts.keepGlobalCoordinates ?? false;
  const shift = (c: Vec3): Vec3 => keepGlobal ? c : [c[0] - nodeMm[0], c[1] - nodeMm[1], c[2] - nodeMm[2]];
  const points = makePointRegistry();
  const nodeId = points.idOf(shift(nodeMm)); // ensure the joint node exists first

  // One material (POC: single grade).
  const materialId = 1;

  // Ensure names are unique to prevent Grasshopper API dictionary key collisions
  const makeUniqueNameGenerator = () => {
    const seen = new Set<string>();
    return (baseName: string) => {
      let name = baseName;
      let i = 2;
      while (seen.has(name)) {
        name = `${baseName} (${i})`;
        i++;
      }
      seen.add(name);
      return name;
    };
  };

  const getUniqueCssName = makeUniqueNameGenerator();
  const getUniqueMemberName = makeUniqueNameGenerator();

  // Distinct cross-sections by profile name.
  const cssIdByProfile = new Map<string, number>();
  const cssList: { id: number; name: string; profile: string; type: string; rotation: number }[] = [];
  const cssIdFor = (rawProfile: string, rotationDeg: number | null): number => {
    const profile = standardizeProfileName(rawProfile || "UNKNOWN");
    const kkey = `${profile}|${rotationDeg ?? 0}`;
    const existing = cssIdByProfile.get(kkey);
    if (existing != null) return existing;
    const id = cssList.length + 1;
    cssIdByProfile.set(kkey, id);
    const uniqueName = getUniqueCssName(profile);
    // `name` is a unique label (a repeated profile at another rotation gets a
    // " (2)" suffix); `profile` is the clean standardized name used verbatim as
    // the MPRL catalog key (UniqueName). The suffix must never leak into the key
    // or IDEA can't resolve the section for the second-and-later occurrence.
    cssList.push({ id, name: uniqueName, profile, type: crossSectionType(profile), rotation: rotationDeg ?? 0 });
    return id;
  };

  // Per member: segment, element, member1d.
  const members = rows.map((r, i) => {
    const memberId = i + 1;
    // Axis snap: if a component of the axial unit is below axisSnapPct% of the
    // largest, zero it and renormalize — a nearly axis-aligned member is set
    // exactly onto the global plane. The far end is redirected along the snapped
    // axis and the LCS section axes re-adapt (lcsXml). `axialU` is used for BOTH
    // the segment direction and the LCS so they stay consistent.
    const snappedU = snapAxis(r.unit, axisSnapPct);
    let axialU: Vec3 = snappedU ?? r.unit;
    const quantU = quantizeAxis(axialU, axisRoundPer1000); // coarsen the tilt to a grid
    if (quantU) axialU = quantU;
    const axisChanged = snappedU != null || quantU != null;
    const segLen = Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1], r.end[2] - r.start[2]);
    let segStart: Vec3 = r.start;
    // Far end: redirected along the (snapped/rounded) axis when it changed, else the real end.
    let segEnd: Vec3 = axisChanged
      ? [r.start[0] + axialU[0] * segLen, r.start[1] + axialU[1] * segLen, r.start[2] + axialU[2] * segLen]
      : r.end;
    // A CONTINUOUS member must pass THROUGH the node (IDEA derives BOTH the
    // Continuous type AND the bearing member from geometry). Our oriented rows
    // are stubs from the node outward, so a Continuous member is extended
    // backward past the node (start := close − axialU·L). Ended members stay stubs.
    if (continuousIds.has(r.globalId)) {
      const L = Math.min(r.length || 2000, 2000); // extend up to 2 m past the node
      segStart = [r.start[0] - axialU[0] * L, r.start[1] - axialU[1] * L, r.start[2] - axialU[2] * L];
    }
    // Eccentricity snap: a NON-bearing member sitting less than
    // `eccentricitySnapMm` off the node is pulled onto it — the EXACT
    // perpendicular offset of its close end from the node is removed, so IDEA
    // shows a clean 0-offset joint. Larger, genuine eccentricities are kept; the
    // along-axis component is already free (IDEA trims it); the bearing member
    // defines the frame and is left untouched.
    if (!r.isBearing && (r.eccentricityMm ?? 0) < eccentricitySnapMm) {
      const g: Vec3 = [r.start[0] - nodeMm[0], r.start[1] - nodeMm[1], r.start[2] - nodeMm[2]];
      const along = g[0] * axialU[0] + g[1] * axialU[1] + g[2] * axialU[2];
      const dx = -(g[0] - along * axialU[0]);
      const dy = -(g[1] - along * axialU[1]);
      const dz = -(g[2] - along * axialU[2]);
      segStart = [segStart[0] + dx, segStart[1] + dy, segStart[2] + dz];
      segEnd = [segEnd[0] + dx, segEnd[1] + dy, segEnd[2] + dz];
    }
    const startId = points.idOf(shift(segStart));
    const endId = points.idOf(shift(segEnd));
    // Cross-section orientation is now conveyed by the per-segment
    // LocalCoordinateSystem (an exact frame from the IFC — see lcsXml), so the
    // CrossSection itself carries NO rotation (0). This is what fixes vertical
    // members that IDEA otherwise twists 90° when it re-derives the frame. One
    // CrossSection per profile then suffices (rotation no longer keys it).
    const cssId = cssIdFor(r.profile, 0);
    const baseName = (r.tag || r.name || `M${memberId}`).trim() || `M${memberId}`;
    const uniqueName = getUniqueMemberName(baseName);
    const isBearing = r.globalId === bearingGlobalId;
    const finalName = opts.markBearingName && isBearing ? `${uniqueName} [BEARING]` : uniqueName;
    return {
      memberId,
      segmentId: memberId,
      elementId: memberId,
      startId,
      endId,
      cssId,
      row: r,
      axialU,
      uniqueName: finalName,
      type: /column/i.test(r.ifcClass) ? "Column" : "Beam",
      isContinuous: continuousIds.has(r.globalId),
      isBearing,
    };
  });

  const P = points.all();

  const xml: string[] = [];
  xml.push(`<?xml version="1.0" encoding="utf-8"?>`);
  // Wrap in <OpenModelContainer> and declare a modern schema version: IDEA
  // StatiCa's current Checkbot importer deserializes the document root as an
  // OpenModelContainer (a bare <OpenModel> root is rejected before the model is
  // ever read). However, the direct API (e.g., Grasshopper Plugin) expects a bare
  // <OpenModel> root and fails to deserialize the container wrapper.
  if (!opts.bareOpenModel) {
    xml.push(
      `<OpenModelContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`,
    );
    xml.push(`<OpenModel>`);
  } else {
    xml.push(
      `<OpenModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`,
    );
  }
  xml.push(`<Version>3.2.0</Version>`);
  xml.push(
    `<OriginSettings><ProjectName>${esc(projectName)}</ProjectName>` +
      `<DateOfCreate>${new Date().toISOString()}</DateOfCreate>` +
      `<CrossSectionConversionTable>${conversionTable}</CrossSectionConversionTable>` +
      `<CountryCode>${countryCode}</CountryCode>` +
      `<ImportRecommendedWelds>false</ImportRecommendedWelds>` +
      `<CheckEquilibrium>true</CheckEquilibrium></OriginSettings>`,
  );

  // Points
  xml.push(`<Point3D>`);
  for (const p of P) {
    xml.push(`<Point3D><Id>${p.id}</Id><Name>${p.name}</Name><X>${p.x}</X><Y>${p.y}</Y><Z>${p.z}</Z></Point3D>`);
  }
  xml.push(`</Point3D>`);

  // Line segments
  xml.push(`<LineSegment3D>`);
  for (const mem of members) {
    // Pin orientation to the IFC frame using the SAME (possibly axis-snapped)
    // axial direction as the segment, so VecX and the segment stay consistent.
    const lcs = lcsXml(mem.axialU, mem.row.crossSectionAxisA, axisSnapPct);
    xml.push(
      `<LineSegment3D><Id>${mem.segmentId}</Id>` +
        `<StartPoint>${ref("Point3D", mem.startId)}</StartPoint>` +
        `<EndPoint>${ref("Point3D", mem.endId)}</EndPoint>` +
        (lcs ?? "") +
        `</LineSegment3D>`,
    );
  }
  xml.push(`</LineSegment3D>`);

  // Material (single MatSteelEc2 — fields mirror the official sample)
  xml.push(`<MatSteel>`);
  xml.push(
    `<MatSteel xsi:type="MatSteelEc2"><Id>${materialId}</Id><Name>${esc(materialName)}</Name>` +
      `<E>210000000000</E><G>80769230769.23</G><Poisson>0.3</Poisson><UnitMass>7850</UnitMass>` +
      `</MatSteel>`,
  );
  xml.push(`</MatSteel>`);

  // Cross sections (by-name via UniqueName param)
  xml.push(`<CrossSection>`);
  for (const c of cssList) {
    xml.push(
      `<CrossSection xsi:type="CrossSectionParameter"><Id>${c.id}</Id><Name>${esc(c.name)}</Name>` +
        `<CrossSectionRotation>${c.rotation * (Math.PI / 180)}</CrossSectionRotation>` +
        `<IsInPrincipal>false</IsInPrincipal>` +
        `<CrossSectionType>${c.type}</CrossSectionType>` +
        `<Parameters><Parameter xsi:type="ParameterString"><Name>UniqueName</Name><Value>${esc(c.profile)}</Value></Parameter></Parameters>` +
        `<Material>${ref("MatSteel", materialId)}</Material>` +
        `</CrossSection>`,
    );
  }
  xml.push(`</CrossSection>`);

  // Element1D (segment ↔ cross-section). Field order mirrors IDEA's own export
  // exactly (CrossSectionBegin/End, then Segment, then RotationRx/Eccentricity):
  // IOM deserializes as an ordered sequence, so a reordered element tree is
  // rejected at parse time — matching the order is what lets the file open.
  xml.push(`<Element1D>`);
  for (const mem of members) {
    xml.push(
      `<Element1D><Id>${mem.elementId}</Id>` +
        `<Name>EB${mem.elementId}</Name>` +
        `<CrossSectionBegin>${ref("CrossSection", mem.cssId)}</CrossSectionBegin>` +
        `<CrossSectionEnd>${ref("CrossSection", mem.cssId)}</CrossSectionEnd>` +
        `<Segment>${ref("LineSegment3D", mem.segmentId)}</Segment>` +
        `<RotationRx>0</RotationRx>` +
        `<EccentricityBegin><X>0</X><Y>0</Y><Z>0</Z></EccentricityBegin>` +
        `<EccentricityEnd><X>0</X><Y>0</Y><Z>0</Z></EccentricityEnd>` +
        `</Element1D>`,
    );
  }
  xml.push(`</Element1D>`);

  // Member1D
  xml.push(`<Member1D>`);
  for (const mem of members) {
    xml.push(
      `<Member1D><Id>${mem.memberId}</Id><Name>${esc(mem.uniqueName)}</Name>` +
        `<Elements1D><ReferenceElement>${ref("Element1D", mem.elementId)}</ReferenceElement></Elements1D>` +
        `<Member1DType>${mem.type}</Member1DType>` +
        `<Alignment>Center</Alignment>` +
        `<MirrorY>false</MirrorY><MirrorZ>false</MirrorZ>` +
        `<EccentricityBegin><X>0</X><Y>0</Y><Z>0</Z></EccentricityBegin>` +
        `<EccentricityEnd><X>0</X><Y>0</Y><Z>0</Z></EccentricityEnd>` +
        `<InsertionPoint>CenterOfGravity</InsertionPoint>` +
        `<EccentricityReference>LocalCoordinateSystem</EccentricityReference>` +
        `<LocalCoordinateSystem>` +
        `<Vector3D><X>${mem.row.localX[0]}</X><Y>${mem.row.localX[1]}</Y><Z>${mem.row.localX[2]}</Z></Vector3D>` +
        `<Vector3D><X>${mem.row.localY[0]}</X><Y>${mem.row.localY[1]}</Y><Z>${mem.row.localY[2]}</Z></Vector3D>` +
        `<Vector3D><X>${mem.row.localZ[0]}</X><Y>${mem.row.localZ[1]}</Y><Z>${mem.row.localZ[2]}</Z></Vector3D>` +
        `</LocalCoordinateSystem>` +
        `</Member1D>`,
    );
  }
  xml.push(`</Member1D>`);

  // ConnectionPoint (which node is the joint + which members meet, continuity)
  xml.push(`<ConnectionPoint>`);
  xml.push(`<ConnectionPoint><Id>1</Id><Name>CON 1</Name><Node>${ref("Point3D", nodeId)}</Node><ConnectedMembers>`);
  members.forEach((mem, i) => {
    xml.push(
      `<ConnectedMember><Id>${i + 1}</Id>` +
        `<MemberId>${ref("Member1D", mem.memberId)}</MemberId>` +
        `<IsContinuous>${mem.isContinuous ? "true" : "false"}</IsContinuous>` +
        `<Length>0</Length>` +
        `</ConnectedMember>`,
    );
  });
  xml.push(`</ConnectedMembers><NodeId>0</NodeId></ConnectionPoint>`);
  xml.push(`</ConnectionPoint>`);

  // ConnectionData / BeamData (design entities + bearing flag). Order mirrors
  // IDEA's export: the ConnectionData points at its ConnectionPoint first, then
  // lists the beams. Each BeamData's field order matches too.
  xml.push(`<Connections><ConnectionData>`);
  xml.push(`<ConnectionPoint>${ref("ConnectionPoint", 1)}</ConnectionPoint>`);
  xml.push(`<Beams>`);
  for (const mem of members) {
    xml.push(
      `<BeamData><Id>${mem.memberId}</Id><Name>${esc(mem.uniqueName)}</Name>` +
        `<OriginalModelId>Beam${mem.memberId}</OriginalModelId>` +
        `<IsAdded>false</IsAdded>` +
        `<AddedMemberLength>0</AddedMemberLength>` +
        `<IsNegativeObject>false</IsNegativeObject>` +
        `<MirrorY>false</MirrorY>` +
        `<RefLineInCenterOfGravity>true</RefLineInCenterOfGravity>` +
        `<IsBearingMember>${mem.isBearing ? "true" : "false"}</IsBearingMember>` +
        `<AutoAddCutByWorkplane>false</AutoAddCutByWorkplane>` +
        `</BeamData>`,
    );
  }
  xml.push(`</Beams></ConnectionData></Connections>`);

  xml.push(`</OpenModel>`);
  if (!opts.bareOpenModel) {
    xml.push(`</OpenModelContainer>`);
  }
  return xml.join("\n");
}
