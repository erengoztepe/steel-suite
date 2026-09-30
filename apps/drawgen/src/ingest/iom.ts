// IOM (IDEA Open Model) XML -> ConnectionModel extractor.
// IOM is UTF-16, .NET-serialized, reference-heavy (xsi:type polymorphism, nested
// wrappers). Strategy mirrors a proven Python approach: recursively collect every
// element by tag name, then filter/resolve by Id -- robust to nesting variance.

import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type {
  ConnectionModel, CrossSection, Plate, BoltGrid, BoltAssembly, Weld, Member, Cut,
  Vec3, Pt2, LCS,
} from '../model/types.ts';

const M_TO_MM = 1000;

// True repeatable collections. NOT CrossSection/BoltAssembly: those appear both as
// definition lists AND as single Id-references; forcing arrays breaks ref access.
// walk() collects them regardless of array-ness, so they need no forcing.
const ARRAY_TAGS = new Set([
  'PlateData', 'BoltGrid', 'WeldData', 'BeamData', 'Member1D',
  'Segment2D', 'Point3D', 'Parameter', 'ReferenceElement',
  'string', 'CutData', 'LineSegment3D', 'PolyLine3D', 'Element1D',
]);

type Node = Record<string, any>;

function parseXml(path: string): Node {
  const raw = readFileSync(path, 'utf16le').replace(/^﻿/, '');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,   // keep strings; we convert explicitly
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  return parser.parse(raw);
}

/** Recursively collect every value stored under `key`, flattening arrays. */
function walk(obj: any, key: string, out: Node[] = []): Node[] {
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item && typeof item === 'object') out.push(item as Node);
      }
    }
    if (Array.isArray(v)) v.forEach((el) => walk(el, key, out));
    else if (v && typeof v === 'object') walk(v, key, out);
  }
  return out;
}

const num = (v: any): number => (v == null ? NaN : parseFloat(String(v)));
const mm = (v: any): number => num(v) * M_TO_MM;
const asArray = <T,>(v: T | T[] | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];
/** Collapse a possibly-array value to its single element (for Id references). */
const one = (v: any): Node | undefined => (Array.isArray(v) ? v[0] : v);

function vec3mm(n: Node | undefined): Vec3 {
  return { x: mm(n?.X), y: mm(n?.Y), z: mm(n?.Z) };
}
function vec3unit(n: Node | undefined): Vec3 {
  return { x: num(n?.X), y: num(n?.Y), z: num(n?.Z) };
}
function lcsOf(n: Node): LCS {
  return {
    origin: vec3mm(n.Origin),
    ax: vec3unit(n.AxisX),
    ay: vec3unit(n.AxisY),
    az: vec3unit(n.AxisZ),
  };
}

// ---- geometry / member-axis resolution ----------------------------------

/** Geometry point table = DIRECT Point3D children of OpenModel (NOT bolt-grid
 * positions, which live under ConnectionData and share the same Id namespace). */
function geomPoints(om: Node): Map<string, Vec3> {
  const map = new Map<string, Vec3>();
  // Points sit in a Point3D-wraps-Point3D collection; walk ONLY that subtree so
  // bolt-grid positions (same Id namespace, under ConnectionData) don't leak in.
  for (const p of walk(om.Point3D, 'Point3D')) {
    if (p?.X != null && p?.Id != null) map.set(String(p.Id), vec3mm(p));
  }
  return map;
}

interface Seg { start: Vec3; end: Vec3; vy?: Vec3; vz?: Vec3; }
function segIndex(om: Node, pts: Map<string, Vec3>): Map<string, Seg> {
  const map = new Map<string, Seg>();
  for (const s of walk(om, 'LineSegment3D')) {
    if (!s.StartPoint) continue;
    const start = pts.get(String(one(s.StartPoint)?.Id));
    const end = pts.get(String(one(s.EndPoint)?.Id));
    if (!start || !end) continue;
    const l = s.LocalCoordinateSystem;
    map.set(String(s.Id), {
      start, end,
      vy: l ? vec3unit(l.VecY) : undefined,
      vz: l ? vec3unit(l.VecZ) : undefined,
    });
  }
  return map;
}

/** Element1D id -> { sectionId, segId } */
function elemIndex(om: Node): Map<string, { sectionId: number; segId: string }> {
  const map = new Map<string, { sectionId: number; segId: string }>();
  for (const e of walk(om, 'Element1D')) {
    if (!e.Segment) continue;
    map.set(String(e.Id), {
      sectionId: num(one(e.CrossSectionBegin)?.Id),
      segId: String(one(e.Segment)?.Id),
    });
  }
  return map;
}

/** Member/Beam id -> Element1D id (via Member1D.Elements1D reference). */
function memberToElement(om: Node): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of walk(om, 'Member1D')) {
    if (!m.Elements1D) continue;
    const elemId = one(m.Elements1D?.ReferenceElement)?.Id;
    if (elemId != null) map.set(String(m.Id), String(elemId));
  }
  return map;
}

// ---- element extractors -------------------------------------------------

function crossSections(root: Node): CrossSection[] {
  const byId = new Map<number, CrossSection>();
  for (const cs of walk(root, 'CrossSection')) {
    if (!cs.Parameters && !cs.CrossSectionType) continue; // skip wrappers/refs
    const id = num(cs.Id);
    if (Number.isNaN(id) || byId.has(id)) continue;
    const params: Record<string, number> = {};
    for (const p of asArray<Node>(cs.Parameters?.Parameter)) {
      if (p?.Name != null) params[String(p.Name)] = mm(p.Value);
    }
    byId.set(id, {
      id, name: String(cs.Name ?? ''), type: String(cs.CrossSectionType ?? ''), params,
    });
  }
  return [...byId.values()];
}

function boltAssemblies(root: Node): BoltAssembly[] {
  const byId = new Map<number, BoltAssembly>();
  for (const b of walk(root, 'BoltAssembly')) {
    if (b.Diameter == null) continue; // skip references
    const id = num(b.Id);
    if (Number.isNaN(id) || byId.has(id)) continue;
    const name = String(b.Name ?? '');
    byId.set(id, {
      id, name,
      diameter: mm(b.Diameter),
      borehole: mm(b.Borehole),
      grade: name.split(/\s+/).slice(1).join(' ') || name,
      headDiameter: mm(b.HeadDiameter),
      headHeight: mm(b.HeadHeight),
      nutThickness: mm(b.NutThickness),
    });
  }
  return [...byId.values()];
}

function plates(root: Node): Plate[] {
  const out: Plate[] = [];
  for (const p of walk(root, 'PlateData')) {
    if (!p.Geometry && !p.Thickness) continue;
    const outline: Pt2[] = [];
    const ol = p.Geometry?.Outline;
    if (ol?.StartPoint) outline.push({ x: mm(ol.StartPoint.X), y: mm(ol.StartPoint.Y) });
    for (const seg of asArray<Node>(ol?.Segments?.Segment2D)) {
      if (seg?.EndPoint) outline.push({ x: mm(seg.EndPoint.X), y: mm(seg.EndPoint.Y) });
    }
    out.push({
      id: num(p.Id),
      name: String(p.Name ?? ''),
      originalId: String(p.OriginalModelId ?? ''),
      thickness: mm(p.Thickness),
      material: String(p.Material ?? ''),
      lcs: lcsOf(p),
      outline,
      isNegative: String(p.IsNegativeObject) === 'true',
    });
  }
  return out;
}

function boltGrids(root: Node, assemblies: BoltAssembly[]): BoltGrid[] {
  const asmById = new Map(assemblies.map((a) => [a.id, a]));
  const out: BoltGrid[] = [];
  for (const g of walk(root, 'BoltGrid')) {
    if (!g.Positions) continue;
    const positions = asArray<Node>(g.Positions?.Point3D).map(vec3mm);
    const connectedParts = asArray<Node>(g.ConnectedParts?.ReferenceElement).map((r) => ({
      type: String(r.TypeName ?? ''), id: String(r.Id ?? ''),
    }));
    const asmId = num(one(g.BoltAssembly)?.Id);
    out.push({
      id: num(g.Id),
      lcs: lcsOf(g),
      positions,
      assembly: asmById.get(asmId),
      connectedParts,
      length: mm(g.Length),
    });
  }
  return out;
}

function welds(root: Node): Weld[] {
  const out: Weld[] = [];
  for (const w of walk(root, 'WeldData')) {
    if (!w.WeldType && !w.Start) continue;
    out.push({
      id: num(w.Id),
      name: String(w.Name ?? ''),
      type: String(w.WeldType ?? ''),
      thickness: mm(w.Thickness),
      material: String(w.Material ?? ''),
      start: vec3mm(w.Start),
      end: vec3mm(w.End),
      connectedPartIds: asArray<any>(w.ConnectedPartIds?.string).map(String),
    });
  }
  return out;
}

/** Best-effort: match a member name to a cross-section (refine via Element1D later). */
function matchSection(memberName: string, sections: CrossSection[]): CrossSection | undefined {
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join('');
  const md = digits(memberName);
  return (
    sections.find((s) => s.name === memberName) ??
    sections.find((s) => digits(s.name) === md && s.name[0] === memberName[0]) ??
    sections.find((s) => digits(s.name) === md)
  );
}

function members(root: Node, sections: CrossSection[]): Member[] {
  const secById = new Map(sections.map((s) => [s.id, s]));
  const pts = geomPoints(root);
  const segs = segIndex(root, pts);
  const elems = elemIndex(root);
  const m2e = memberToElement(root);

  const out: Member[] = [];
  for (const b of walk(root, 'BeamData')) {
    if (b.Name == null) continue;
    const id = num(b.Id);
    const cuts: Cut[] = asArray<Node>(b.Cuts?.CutData).map((c) => ({
      planePoint: vec3mm(c.PlanePoint),
      normal: vec3unit(c.NormalVector),
      direction: String(c.Direction ?? ''),
      offset: mm(c.Offset),
    }));

    // link BeamData -> Element1D (via Member1D ref, else by matching id)
    const elemId = m2e.get(String(id)) ?? String(id);
    const el = elems.get(elemId);
    const seg = el ? segs.get(el.segId) : undefined;

    const section =
      (el && secById.get(el.sectionId)) || matchSection(String(b.Name), sections);

    out.push({
      id,
      name: String(b.Name),
      isBearing: String(b.IsBearingMember) === 'true',
      section,
      axis: seg ? { start: seg.start, end: seg.end } : undefined,
      sectionFrame: seg?.vy && seg?.vz ? { vy: seg.vy, vz: seg.vz } : undefined,
      cuts,
    });
  }
  return out;
}

// ---- entry point --------------------------------------------------------

export function loadIom(path: string): ConnectionModel {
  const doc = parseXml(path);
  const om = doc.OpenModelContainer?.OpenModel ?? doc.OpenModel ?? doc;
  const origin = om.OriginSettings ?? {};

  const crossSecs = crossSections(om);
  const asms = boltAssemblies(om);

  return {
    projectName: String(origin.ProjectName ?? ''),
    countryCode: String(origin.CountryCode ?? ''),
    source: path,
    units: 'mm',
    crossSections: crossSecs,
    boltAssemblies: asms,
    plates: plates(om),
    boltGrids: boltGrids(om, asms),
    welds: welds(om),
    members: members(om, crossSecs),
  };
}
