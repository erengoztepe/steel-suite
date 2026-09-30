// Builds a multi-view DrawingSpec (elevation + section) for a connection in the
// house style: drawn on ROLES (visible/hidden/axis/text/...), which the style profile maps
// to real layers, bolt glyphs, centrelines, labels. No hidden-line removal / dimensions / paperspace yet.

import type { ConnectionModel, Member, Plate, BoltGrid, Vec3 } from '../model/types.ts';
import type { DrawingSpec, Entity, Pt, LayerSpec, ViewDef, OccluderBox } from '../model/drawing.ts';
import { isIShape } from './profile.ts';
import { planViews, type Archetype, type Plan, type PlannedView } from './viewplan.ts';
import { STYLE, STYLE_PATH } from '../model/style.ts';

// ---- vector helpers ----
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return scale(a, 1 / l); };
const n2 = (a: [number, number]): [number, number] => {
  const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l];
};

// House layers: colour 7 everywhere; hierarchy by lineweight (1/100 mm).
const LAYERS: LayerSpec[] = [
  { name: 'visible', color: 7, lineweight: 35 },
  { name: 'visible_thin', color: 7, lineweight: 18 },
  { name: 'hidden', color: 7, lineweight: 18, linetype: 'HIDDEN' },
  { name: 'bolt', color: 7, lineweight: 18 },
  { name: 'axis', color: 7, lineweight: 13, linetype: 'CENTER' },
  { name: 'text', color: 7, lineweight: 18 },
];

// Text heights (model mm): a 3-tier ladder from profile text_height.* -- `title` for view
// titles/bubble numbers, `sub` for the view-title scale line, `label` for everything else
// (member labels, plate marks, dim text, callouts). On a 1:10 sheet these read as the
// house's paper sizes (height / 10).
const { title: H_TITLE, sub: H_SUB, label: H_LABEL } = STYLE.text_height;

/** House policy for the build in progress, set once by `buildDrawing` (the module's only entry
 * point) so the view builders don't each have to carry it through their already-long signatures.
 * Module-level rather than threaded because a build is a single synchronous pass. */
let TITLE_STYLE: 'bubble' | 'underline' = 'bubble';

interface Frame { origin: Vec3; u: Vec3; v: Vec3; }

// The IOM's own geometry carries floating-point noise (e.g. z = 49.00000001764884 instead of
// 49) that survives every downstream transform. It never changes a MEASURED value (dimensions
// already round to whole mm), but it does leave junk digits in raw coordinates. Round every
// emitted coordinate to a fixed sub-micron precision so the DXF is clean without touching
// anything that is a genuine fractional design value.
// A non-finite value must never reach the spec: JSON.stringify turns NaN/Infinity into `null`,
// which survives all the way into render.py and surfaces there as a `NoneType` TypeError
// hundreds of lines from the geometry that produced it (mm) or inside _scale_spec (cm) -- two
// different tracebacks for one upstream defect. Fail here, where the culprit is still on the
// stack. Seen for real: a degenerate dimension chain yielding Math.min(...[]) === Infinity.
const R = (n: number): number => {
  if (!Number.isFinite(n)) throw new Error(`non-finite coordinate (${n}) -- degenerate geometry upstream`);
  return Math.round(n * 1000) / 1000;
};
const rp = (p: Pt): Pt => [R(p[0]), R(p[1])];

class Painter {
  entities: Entity[] = [];
  readonly normal: Vec3;
  /** Signatures of end-on profiles already drawn at a given projected position in this view --
   * two DIFFERENT members (e.g. a member and its own welded stub) can be collinear and share
   * the same section, so they project to the identical outline; without this a stub duplicates
   * its parent's whole I-profile + label on top of itself (verified: exact duplicate entities
   * in the FRONT VIEW of an end-plate connection). */
  private drawnProfiles = new Set<string>();
  constructor(private f: Frame, private ox: number, private oy: number) {
    this.normal = norm(cross(f.u, f.v));
  }
  p(g: Vec3): Pt { const d = sub(g, this.f.origin); return [dot(d, this.f.u) + this.ox, dot(d, this.f.v) + this.oy]; }
  d(g: Vec3): [number, number] { return [dot(g, this.f.u), dot(g, this.f.v)]; }
  poly(layer: string, closed: boolean, points: Pt[]) { this.entities.push({ type: 'polyline', layer, closed, points: points.map(rp) }); }
  circle(layer: string, center: Pt, r: number) { this.entities.push({ type: 'circle', layer, center: rp(center), r: R(r) }); }
  line(layer: string, start: Pt, end: Pt) { this.entities.push({ type: 'line', layer, start: rp(start), end: rp(end) }); }
  text(layer: string, pos: Pt, height: number, text: string, align: 'left' | 'center' | 'right' = 'left',
       opts?: { avoid?: boolean; leader?: Pt }) {
    this.entities.push({ type: 'text', layer, pos: rp(pos), height, text, align, ...opts });
  }
  /** Member/plate label with the house underlined leader. The underline length and the
   * solid arrowhead (profile leader_arrow.label) are produced by the Python side (it has the font metrics and sees the
   * IFC linework the label must dodge) -- see the `label` entity in ../model/drawing.ts. */
  label(layer: string, pos: Pt, height: number, text: string, anchor?: Pt,
        align: 'left' | 'center' | 'right' = 'left', underline: 'label' | 'title' = 'label') {
    this.entities.push({ type: 'label', layer, pos: rp(pos), height, text, align, underline,
      ...(anchor ? { anchor: rp(anchor) } : {}) });
  }
  arc(layer: string, center: Pt, r: number, start: number, end: number) {
    this.entities.push({ type: 'arc', layer, center: rp(center), r: R(r), start, end });
  }
  crossMark(layer: string, c: Pt, size: number) {
    this.line(layer, [c[0] - size, c[1]], [c[0] + size, c[1]]);
    this.line(layer, [c[0], c[1] - size], [c[0], c[1] + size]);
  }
  dim(layer: string, p1: Pt, p2: Pt, base: Pt, angle: number) {
    this.entities.push({ type: 'dim', layer, p1: rp(p1), p2: rp(p2), base: rp(base), angle });
  }
  /** Solid-filled region -- the only fill the house style uses inside a detail (arrowheads,
   * weld-symbol triangles). Cut steel faces are deliberately NOT hatched; see solidFill's
   * callers and the note on the `hatch` entity in ../model/drawing.ts. */
  solidFill(layer: string, boundary: Pt[]) {
    this.entities.push({ type: 'hatch', layer, boundary: boundary.map(rp), solid: true });
  }
  /** A 3D polyline, OCCLUSION-CLIPPED by the Python side against whatever steel actually sits
   * between it and the viewer in the NAMED view (see the `poly3d` Entity + RayOccluder in
   * server/ifc_geom.py). Used for glyphs (bolts) whose visible portion this TS side cannot
   * decide on its own, since only the Python side holds the IFC meshes. `view` must match a
   * ViewDef.name exactly. */
  poly3d(layer: string, view: string, points: Vec3[],
         opts?: { closed?: boolean; clip?: 'segment' | 'whole' | 'none'; group?: string }) {
    this.entities.push({
      type: 'poly3d', layer, view,
      points: points.map((p): [number, number, number] => [R(p.x), R(p.y), R(p.z)]),
      ...opts,
    });
  }
  /** True the first time this (position, profile) pair is seen in this view; registers it so a
   * later collinear/coincident member with the same section is recognised as a duplicate. */
  claimProfile(c: Pt, params: Record<string, number>): boolean {
    const key = [R(c[0]), R(c[1]), params.B, params.H, params.s, params.t, params.r2].join(',');
    if (this.drawnProfiles.has(key)) return false;
    this.drawnProfiles.add(key);
    return true;
  }
  /** 2D bounding box of everything drawn so far. */
  bounds(): { min: Pt; max: Pt } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const upd = (p: Pt) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); };
    for (const e of this.entities) {
      if (e.type === 'polyline') e.points.forEach(upd);
      else if (e.type === 'line') { upd(e.start); upd(e.end); }
      else if (e.type === 'circle') { upd([e.center[0] - e.r, e.center[1] - e.r]); upd([e.center[0] + e.r, e.center[1] + e.r]); }
    }
    return { min: [x0, y0], max: [x1, y1] };
  }
}

const STUB = 350; // side-on member draw length past the joint (mm)

function drawMember(P: Painter, m: Member) {
  if (!m.axis || !m.section || !m.sectionFrame || !isIShape(m.section.type)) return;
  // Part OUTLINES come from the IFC solids (Python side); here we draw only the
  // member annotations (centreline + label) using the same view frame.
  const { B, H } = m.section.params;
  const dir = norm(sub(m.axis.end, m.axis.start));
  const endOn = Math.abs(dot(dir, P.normal)) > 0.7;
  const t0 = -dot(m.axis.start, dir);
  const jt = add(m.axis.start, scale(dir, t0)); // axis point nearest connection origin

  if (endOn) {
    const c = P.p(jt);
    // A member and its own stub (same section, collinear axis) project to the identical
    // outline here -- skip the second draw rather than stack an exact duplicate on top.
    if (!P.claimProfile(c, m.section.params)) return;
    // Seen end-on => draw the TRUE rolled profile from the section table. The IFC ships an
    // un-cut member as a 24-vertex box, so relying on the silhouette would render this member
    // as a bare B x H rectangle (the caller therefore excludes end-on members from the IFC pass).
    drawIProfile(P, m.section.params, c);
    // Centroid cross, +-100 (200 overall) for an end-on member: a 200-long horizontal at the
    // centroid crossed by a 200-long vertical. We drew +-50 out of a worry that a longer arm
    // would land on the beam flange; it does cross the flange line, and that is normal for a
    // centreline.
    P.crossMark('axis', c, 100);
    // underlined leader, like every other member label -- a bare caption over a bare stub line
    // was our own invention
    P.label('text', [c[0], c[1] + H / 2 + 210], H_LABEL, memberLabel(m),
      [c[0], c[1] + H / 2], 'center');
    return;
  }

  const ext0 = sideOnExtent(P, m);
  if (!ext0) return;
  const { A, Bp, d2, hDim } = ext0;
  const ext = (pt: Pt, s: number): Pt => [pt[0] + d2[0] * s, pt[1] + d2[1] * s];
  P.line('axis', ext(A, -30), ext(Bp, 30));
  P.label('text', [Bp[0], Bp[1] + hDim / 2 + 60], H_LABEL, memberLabel(m),
    [Bp[0], Bp[1] + hDim / 2], 'center');
}

/** The side-on (not end-on) draw geometry for a member in view `P`: its axis clamped to a
 * STUB-length stub past the joint, projected into paper space, plus the 2D unit direction
 * along the axis and which section dimension (B or H) reads as its drawn "height" here.
 * Extracted from drawMember so any other pass needing a member's drawn extent in this view (its
 * centreline, its label anchor, its plate-station projection) derives it from ONE place and
 * cannot disagree with the member's own drawn ends. */
function sideOnExtent(P: Painter, m: Member): { A: Pt; Bp: Pt; d2: [number, number]; hDim: number } | undefined {
  if (!m.axis || !m.section || !m.sectionFrame) return undefined;
  const { B, H } = m.section.params;
  const dir = norm(sub(m.axis.end, m.axis.start));
  const t0 = -dot(m.axis.start, dir);
  const jt = add(m.axis.start, scale(dir, t0));
  const vyIn = Math.abs(dot(m.sectionFrame.vy, P.normal)) < 0.35;
  const hDim = vyIn ? B : H;
  const c = P.p(jt);
  const d2 = n2(P.d(dir));
  const along = (pt: Pt) => (pt[0] - c[0]) * d2[0] + (pt[1] - c[1]) * d2[1];
  const ps = Math.max(-STUB, Math.min(STUB, along(P.p(m.axis.start))));
  const pe = Math.max(-STUB, Math.min(STUB, along(P.p(m.axis.end))));
  const A: Pt = [c[0] + d2[0] * ps, c[1] + d2[1] * ps];
  const Bp: Pt = [c[0] + d2[0] * pe, c[1] + d2[1] * pe];
  return { A, Bp, d2, hDim };
}

// NOTE -- `webLines` (parametric dashed web-under-flange lines) HAS BEEN REMOVED.
//
// It existed on the premise that "the IFC ships an un-cut member as a plain box, so its web is
// NOT in the silhouette". Both halves of that are wrong. The IFC ships a real I-PRISM (24 unique
// vertices = 12 per end face, web at +-tw/2 -- measured HEA260 +-3.75, HEA160 +-3.0), and
// `view_linework` already emits the web as a feature edge. So the web was being drawn TWICE: once
// solid by the silhouette pass and once dashed here, 0.05 apart. In the plan that produced one web
// face solid-plus-dashed and the other dashed-only -- the same web reading with two different
// linetypes.
//
// The real defect was that the plan set `hlr: false` (to stop inter-part HLR misranking its flush
// flanges) and thereby also disabled SELF-HLR, which is what correctly classifies a web behind its
// own flange as hidden. Those are now separate switches: the plan asks for
// `interPartHlr: false, selfHlr: true` and the silhouette pass dashes the web on its own.
//
// The general lesson: before adding a parametric pass to "fill in" something a geometric pass is
// believed to miss, check that the geometric pass really misses it -- otherwise the two disagree
// and one edge ends up with two owners. See docs 8.11 / 8.12 D4-D5.

/** Feature-derived PLAN frame for the end-plate archetype: looking straight down. `n` (the
 * view normal) is the cross of the two members' own axes, sign-corrected against the bearing
 * member's own "up" (`sectionFrame.vz`) so the flanges read face-on regardless of the raw
 * cross-product sign; `v` = the bearing member's own axis (reads vertically on the sheet),
 * `u` = perpendicular to it in the view plane (the carried member's axis reads horizontally).
 * Result: the bearing member runs one way and the carried member crosses it at 90 degrees,
 * both seen at their flange WIDTH (not their depth). */
function planFrame(bearing: Member, carried: Member): Frame | undefined {
  if (!bearing.axis || !carried.axis || !bearing.sectionFrame) return undefined;
  const dirB = norm(sub(bearing.axis.end, bearing.axis.start));
  const dirC = norm(sub(carried.axis.end, carried.axis.start));
  let n = norm(cross(dirB, dirC));
  if (dot(n, bearing.sectionFrame.vz) < 0) n = scale(n, -1);
  const v = dirB;
  const u = cross(v, n);
  return { origin: nearestAxisPoint(bearing), u, v };
}

/** The PLAN (parent) view for the end-plate archetype: looking straight down (see planFrame).
 *
 * `interPartHlr: false` is deliberate -- both members' top flanges are flush (the same real-world
 * z), but `view_linework`'s inter-part HLR ranks by MEAN depth, which would misclassify the
 * shallower carried member as "nearer" and chop the bearing member's flange edge into `hidden`
 * dashes under it. `selfHlr: true` is equally deliberate: it is what makes each member's own web
 * read dashed beneath its own flange. Turning BOTH off (the old single `hlr: false`) is what left
 * the web solid and invited a parametric dashed copy on top of it -- see the removed `webLines`.
 *
 * Bolt glyphs are intentionally NOT drawn here: from directly above, both members' flanges fully
 * bury every bolt in this model (no plate-to-plate erection gap is modelled),
 * so occlusion-clipping would legitimately produce zero visible glyphs. */
function buildPlanView(
  model: ConnectionModel, bearing: Member, carried: Member, ox: number, oy: number, num: string,
  frame?: Frame,
): { view: ViewDef; entities: Entity[] } | undefined {
  // The frame comes from the view PLAN (feature-derived, see viewplan.ts); planFrame is the
  // fallback for a direct call without a plan.
  const f = frame ?? planFrame(bearing, carried);
  if (!f || !bearing.section) return undefined;
  const P = new Painter(f, ox, oy);
  for (const mem of model.members) drawMember(P, mem);
  // axial chain (plate faces + the bearing member's web centreline) -- see axialStationChain,
  // shared with the joint section so both print the same 10 | 1 | 10 | 180.
  const plates = model.plates.filter((p) => !p.isNegative);
  const dimVEnd = oy - (bearing.section.params.H ?? 0) / 2 - 90;
  axialStationChain(P, model, bearing, ox, oy, dimVEnd);
  // plate mark: every plate the same house-style-printable thickness -> one shared label,
  // anchored on the pack's own PROJECTED CENTRE. Derived from the plate outlines rather than from
  // the dimension chain's stations: the chain measures the stack along `u` only, so it is empty
  // whenever the pack is seen edge-on across `u` (a collinear splice's PLAN) -- and the mark still
  // has to name the plate in that view. Reading the (then empty) station list is what produced a
  // NaN u-coordinate that reached render.py as `null`.
  if (plates.length) {
    const t0 = plates[0]!.thickness;
    if (plates.every((p) => Math.abs(p.thickness - t0) < 0.5) && Math.abs(t0 - Math.round(t0)) < 0.05) {
      const plateU = centroid(plates.flatMap((pl) => plateGlobal(pl).map((g) => P.p(g))))[0];
      const carriedExt = sideOnExtent(P, carried);
      const vOff = (carriedExt?.hDim ?? 160) / 2;
      labelLeader(P, [plateU, oy + vOff * 0.5], [plateU + 96, oy + vOff + 46],
        H_LABEL, `PL ${Math.round(t0)}`, 'left');
    }
  }
  // numbered view title, drawn HERE (noTitle on the returned view) so the PLAN uses the same
  // callout-bubble convention as every other numbered view. Placed below whichever is lower --
  // the drawn geometry or the axial dim chain -- AND to the right of everything drawn, so it
  // can never land on top of a member centreline (which, unlike an off-centre label, always
  // sits at the bbox's horizontal MIDDLE and so is exactly where a centred title would go).
  const bnd = P.bounds();
  const titleY = Math.min(bnd.min[1], dimVEnd) - 90;
  viewTitle(P, [bnd.max[0] + 90, titleY], num, 'PLAN', '1:10', TITLE_STYLE);
  return {
    view: {
      name: 'PLAN', num,
      origin: [f.origin.x, f.origin.y, f.origin.z], u: [f.u.x, f.u.y, f.u.z], v: [f.v.x, f.v.y, f.v.z],
      ox, oy, crop: [470, 400], interPartHlr: false, selfHlr: true, noTitle: true,
    },
    entities: P.entities,
  };
}

function plateGlobal(pl: Plate): Vec3[] {
  return pl.outline.map((o) => add(pl.lcs.origin, add(scale(pl.lcs.ax, o.x), scale(pl.lcs.ay, o.y))));
}

/** The two FACE planes of a plate along its thickness axis (global mm). `lcs.origin` is the
 * plate's MID-PLANE, not a face -- verified against the IFC solid (STUB1-EPa: `origin.x=-195`,
 * but the actual solid spans `x in [-200,-190]`, i.e. origin sits exactly halfway through the
 * 10mm plate). A face is therefore at `origin ± az * t/2`, not at `origin` and `origin + az*t`
 * as if origin were already a face -- that convention silently drew every plate-thickness
 * dimension 5mm off the plate it measured. */
function plateFaces(pl: Plate): { a: Vec3; b: Vec3 } {
  const half = scale(pl.lcs.az, pl.thickness / 2);
  return { a: sub(pl.lcs.origin, half), b: add(pl.lcs.origin, half) };
}

function centroid(pts: Pt[]): Pt {
  const s = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]] as Pt, [0, 0] as Pt);
  return [s[0] / pts.length, s[1] / pts.length];
}

// (An older bare centred-caption `viewTitle(P, label, scaleTxt)` lived here. It had no call sites
// left -- every view now goes through the policy-aware viewTitle below -- so it is removed rather
// than left as a second, silently divergent way to title a view.)

/** Fabrication label for a member: its rolled-section designation (e.g. "HEA260") when the
 * section table names it, else the IDEA beam name. The house style labels members by
 * SECTION, not by the (often bare-number) IDEA beam name -- HEA260/HEA160, not 260/160. */
const memberLabel = (m: Member): string => m.section?.name || m.name;

/** Member/plate label + leader in the house grammar (docs 8.6): the landing is an UNDERLINE
 * beneath the text, from 6mm before the string's left edge to 6mm past its right edge and 6mm
 * below the baseline; the leader kinks from whichever end of that underline is nearest the
 * anchor; a SOLID arrowhead (profile leader_arrow.label) sits at the anchor.
 *
 * Two things this used to get wrong. (a) The text was placed BESIDE the landing rather than on
 * top of it, and the landing was a fixed short stub -- 22mm where 'HEA260' needs ~119. (b) The
 * arrowhead used the WELD leader's size. Label and weld leaders have distinct arrowheads
 * (profile leader_arrow.label vs leader_arrow.weld), chosen by annotation class (docs 8.5).
 *
 * The geometry now lives on the Python side (see the `label` entity): the underline length needs
 * real font metrics, which TS does not have -- estimating it was how (a) happened. */
function labelLeader(
  P: Painter, anchor: Pt, textPos: Pt, height: number, text: string,
  align: 'left' | 'center' | 'right' = 'left',
) {
  P.label('text', textPos, height, text, anchor, align);
}

/** How a view announces itself, per the active house policy (see DrawingSpec.meta.viewTitle).
 * `center` is the bubble CENTRE for 'bubble' and the title's text insert for 'underline'.
 * Mirrored by _view_bubble on the Python side for IFC-titled views, so TS- and Python-drawn
 * titles read identically.
 *
 * EVERY view must go through here. The fin-plate SECTION A-A used to draw its own bare caption,
 * so it was the only view on the sheet without a bubble -- a reader could not tell whether that
 * was deliberate or a bug. */
function viewTitle(P: Painter, center: Pt, num: string, name: string, scaleTxt: string,
                   style: 'bubble' | 'underline' = 'bubble') {
  const [cx, cy] = center;
  if (style === 'underline') {
    // 'underline' policy: underlined plain text only -- no bubble, no number, no scale (the scale lives in
    // the sheet-level bubble). The underline needs the real text width, so it is drawn by the
    // Python side via the `label` entity's 'title' variant.
    P.label('text', center, H_TITLE, name, undefined, 'left', 'title');
    return;
  }
  P.circle('text', center, STYLE.view_title.bubble_r);
  // title AND the bubble's own number are the SAME height (profile text_height.title) --
  // the scale line one tier down (text_height.sub).
  P.text('text', [cx, cy], H_TITLE, num, 'center');
  P.text('text', [cx + 105, cy + 14], H_TITLE, name, 'left');
  P.text('text', [cx + 105, cy - 40], H_SUB, scaleTxt, 'left');
}

/** Bolt grade naming: normalise ASTM -> metric (EN) so metric drawings read right. */
function normalizeGrade(g: string): string {
  const map: Record<string, string> = { A490M: '10.9', A490: '10.9', A325M: '8.8', A325: '8.8' };
  return map[g.toUpperCase()] ?? g;
}

const wlen = (w: { start: Vec3; end: Vec3 }): number =>
  Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y, w.end.z - w.start.z);

// House weld convention: the PRINTED number is the LEG size z; IOM WeldData.thickness is the
// THROAT a (IOM values such as 2.83 and 4.24 are precisely 2*sqrt2 and 3*sqrt2, and z=a*sqrt2
// converts them to the whole-mm leg sizes 4 and 6). The house style never prints an "a"/"z"
// prefix on the value (a prefix like that belongs to a sheet legend, not to an issued detail).
const weldSize = (iomThroat: number): number => Math.round(iomThroat * Math.SQRT2);

const isDoubleWeld = (t: string): boolean => /double/i.test(t);
/** PJP / partial-penetration bevel (single-bevel) groove weld, per the IOM's `Bevel` type --
 * as opposed to a fillet. Distinguishes the glyph (see weldSymbol): a fillet is a triangle, a
 * bevel is drawn as a vertical stroke plus a 45-degree slant from mid-height to the top, and
 * (house convention) is NEVER mirrored the way a double fillet is. */
const isBevelWeld = (t: string): boolean => /bevel/i.test(t);

/** ISO weld symbol in the house grammar: a leader with a solid arrowhead (profile
 * leader_arrow.weld), a horizontal reference line, and ONE of two glyphs selected by the IOM weld TYPE.
 *
 * EVERYTHING HERE LIVES ON THE `dimension` ROLE, not `text`: the weld size text, its reference
 * line, its glyph and its arrowhead all belong to the dimension class -- so in a profile where
 * the two roles differ in colour, weld arrows print in the dimension colour while member-label
 * arrows print in the text colour. We had the value text on the text layer (docs 8.12/D10).
 *
 * THE FILLET TRIANGLE IS AN OUTLINE, NOT A SOLID FILL: two legs of length S and a hypotenuse of
 * S*sqrt2, i.e. three LINEs per triangle. An earlier claim that "every weld triangle is a SOLID
 * fill" mis-attributed the solid fills on a sheet -- those are the leader arrowheads and
 * section-mark arrows (docs 8.7).
 *   - FILLET (`Fillet`/`FilletRear`/`DoubleFillet`): a right triangle, right-angle corner on
 *     the reference line nearest the elbow, legs = S along the line and upward: `double` (a
 *     DoubleFillet) mirrors a second triangle below the line.
 *   - PJP / BEVEL (`Bevel`): a full-height vertical stroke (0..S) plus a 45-degree slant from
 *     half-height to the top -- single-sided ONLY, never mirrored (an edge-to-edge
 *     partial-penetration groove).
 * Glyph size S=37.57, text 5.3mm above the reference line, bare numeric label. `reach` is a
 * PLACEMENT choice sized to the view's own geometry -- a small end-plate section needs a much
 * shorter reach than a full elevation, or the symbol lands off in space. */
const WELD_LAYER = 'dimension';
const [ARROW_WELD_L, ARROW_WELD_W] = STYLE.leader_arrow.weld;   // profile leader_arrow.weld (docs 8.5)

/** Solid triangular arrowhead, apex at `apex`, pointing away from `from`. SOLID FILL ONLY -- the
 * house style never outlines an arrowhead, and drawing both put a BYLAYER-coloured outline around a
 * fill and made every head read a touch heavy (docs 8.12/D2). */
function solidArrow(P: Painter, layer: string, apex: Pt, from: Pt, len: number, wid: number) {
  const dx = apex[0] - from[0], dy = apex[1] - from[1];
  const n = Math.hypot(dx, dy) || 1;
  const ux = dx / n, uy = dy / n, px = -uy, py = ux;
  const base: Pt = [apex[0] - ux * len, apex[1] - uy * len];
  P.solidFill(layer, [apex, [base[0] + px * wid / 2, base[1] + py * wid / 2],
    [base[0] - px * wid / 2, base[1] - py * wid / 2]]);
}

function weldSymbol(
  P: Painter, anchor: Pt, weldType: string, iomThroat: number, side: 'left' | 'bottom',
  reach: number = side === 'left' ? 260 : 230,
) {
  const size = weldSize(iomThroat);
  const double = isDoubleWeld(weldType);
  const bevel = isBevelWeld(weldType);
  const S = 37.57;
  const label = `${size}`;
  const L = WELD_LAYER;
  if (side === 'left') {
    const refX = anchor[0] - reach, y = anchor[1];
    P.line(L, anchor, [refX + 60, y]);        // leader to weld
    solidArrow(P, L, anchor, [refX + 60, y], ARROW_WELD_L, ARROW_WELD_W);
    P.line(L, [refX, y], [refX + 60, y]);     // reference line
    const gx = refX + 18;
    if (bevel) {
      P.line(L, [gx, y], [gx, y + S]);
      P.line(L, [gx, y + S / 2], [gx + S / 2, y + S]);
    } else {
      // OUTLINE triangle (3 lines), never a solid fill -- see the note above.
      const tri = (s: number) => P.poly(L, true, [[gx, y], [gx + S, y], [gx, y + S * s]]);
      tri(1);
      if (double) tri(-1);
    }
    P.text(L, [gx - 6, y + 5.3], H_LABEL, label, 'right', { avoid: true });
  } else {
    const x = anchor[0], refY = anchor[1] - reach;
    P.line(L, anchor, [x, refY + 60]);
    solidArrow(P, L, anchor, [x, refY + 60], ARROW_WELD_L, ARROW_WELD_W);
    P.line(L, [x - 35, refY], [x + 35, refY]);
    const gy = refY + 18;
    if (bevel) {
      P.line(L, [x, gy], [x + S, gy]);
      P.line(L, [x + S / 2, gy], [x + S, gy + S / 2]);
    } else {
      const tri = (s: number) => P.poly(L, true, [[x, gy], [x, gy + S], [x + S * s, gy]]);
      tri(1);
      if (double) tri(-1);
    }
    P.text(L, [x - 6, gy + 5.3], H_LABEL, label, 'left', { avoid: true });
  }
}

/** Hex nut outline, circumradius R (across-corners = 2R), vertex left/right. */
function hexPts(c: Pt, R: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
  }
  return pts;
}

/** Standard bolt/nut/washer geometry lookup: nominal shank diameter (mm) -> dimensions from
 * server/data/bolts.json (ISO 4014 hex bolt, ISO 4032 nut, ISO 7089 washer -- the STANDARD
 * series is listed first there and so is the default; see loadBoltDims in build.ts). */
export type BoltDims = Map<number, {
  s: number; e: number; k: number; m: number; washerThickness: number;
}>;

/** Fully-resolved parametric bolt template for ONE diameter, with fallback RATIOS (documented
 * against the DB's own values) when no DB row exists for that diameter. */
interface BoltTemplate {
  d: number; s: number; e: number; k: number; m: number; washerT: number; washerOD: number;
  protrusion: number;   // shank length proud of the nut -- 0.625d (10mm on M16)
}
function boltTemplate(diameter: number, dims: BoltDims | undefined): BoltTemplate {
  const d = diameter;
  const row = dims?.get(Math.round(d));
  const s = row?.s ?? 1.5 * d;
  return {
    d, s,
    e: row?.e ?? s / Math.cos(Math.PI / 6),
    k: row?.k ?? 0.625 * d,
    m: row?.m ?? 0.925 * d,
    washerT: row?.washerThickness ?? 0.1875 * d,
    washerOD: 1.85 * d,   // ISO 7089 OD ~= 1.85d (existing formula; M16 -> 30)
    protrusion: 0.625 * d,
  };
}

/** The bolt PACK's outer face extents along its OWN axis (`grid.lcs.az`), from the connected
 * plates' real FACE planes (plateFaces -- never a hardcoded grip length). `minT`/`maxT` are
 * scalar projections (`dot(facePoint, axis)`); a specific bolt's own face points are recovered
 * from these via its own position (see drawBoltGlyphsSideOn/EndOn), since the pack thickness
 * is constant across the whole plate regardless of in-plane (row/column) position. */
function boltPack(model: ConnectionModel, grid: BoltGrid):
  { axis: Vec3; minT: number; maxT: number } | undefined {
  const axis = norm(grid.lcs.az);
  const plates = model.plates.filter((p) => !p.isNegative);
  if (!plates.length) return undefined;
  let minT = Infinity, maxT = -Infinity;
  for (const pl of plates) {
    const { a, b } = plateFaces(pl);
    minT = Math.min(minT, dot(a, axis), dot(b, axis));
    maxT = Math.max(maxT, dot(a, axis), dot(b, axis));
  }
  return Number.isFinite(minT) && Number.isFinite(maxT) ? { axis, minT, maxT } : undefined;
}

/** Parametric occluder boxes (flange / flange / web) for an I-section member -- used ONLY to
 * decide whether a bolt glyph is hidden behind this member's material. The IFC ships every
 * un-cut member as a single 24-vertex BOX unsuited to telling "behind the flange" from "behind
 * the web" apart (see drawIProfile's docstring on why the IFC can't be trusted for this
 * member's own drawn geometry either). Returns [] for a non-I-section or incomplete data. */
function memberOccluders(mem: Member): OccluderBox[] {
  if (!mem.axis || !mem.sectionFrame || !mem.section || !isIShape(mem.section.type)) return [];
  const { B, H } = mem.section.params;
  const tf = mem.section.params.t ?? 0, tw = mem.section.params.s ?? 0;
  if (!B || !H || !tf) return [];
  const axisDir = norm(sub(mem.axis.end, mem.axis.start));
  const mid = scale(add(mem.axis.start, mem.axis.end), 0.5);
  const { vy, vz } = mem.sectionFrame;
  // padded well past the member's real cut ends -- occlusion doesn't need cope accuracy, just
  // "is there material here", and a stub short-shipped past its true length is still a solid.
  const halfLen = Math.hypot(mem.axis.end.x - mem.axis.start.x, mem.axis.end.y - mem.axis.start.y,
    mem.axis.end.z - mem.axis.start.z) / 2 + 500;
  const box = (name: string, center: Vec3, halfB: number, halfT: number): OccluderBox => ({
    name, center: [center.x, center.y, center.z],
    ax: [axisDir.x, axisDir.y, axisDir.z], ay: [vy.x, vy.y, vy.z], az: [vz.x, vz.y, vz.z],
    half: [halfLen, halfB, halfT],
  });
  const flangeOff = (H - tf) / 2;
  return [
    box(`${mem.name}-flange-top`, add(mid, scale(vz, flangeOff)), B / 2, tf / 2),
    box(`${mem.name}-flange-bottom`, add(mid, scale(vz, -flangeOff)), B / 2, tf / 2),
    box(`${mem.name}-web`, mid, tw / 2, (H - 2 * tf) / 2),
  ];
}

/** Dash-dot gauge centrelines through every bolt row/column (`axis` role) -- shared by every
 * end-on bolted view regardless of which glyph convention (circles vs hex) it draws. */
function drawBoltAxisLines(P: Painter, grid: BoltGrid) {
  const b2 = grid.positions.map((p) => P.p(p));
  const uMin = Math.min(...b2.map((p) => p[0])), uMax = Math.max(...b2.map((p) => p[0]));
  const vMin = Math.min(...b2.map((p) => p[1])), vMax = Math.max(...b2.map((p) => p[1]));
  for (const u of new Set(b2.map((p) => Math.round(p[0])))) P.line('axis', [u, vMin - 45], [u, vMax + 45]);
  for (const v of new Set(b2.map((p) => Math.round(p[1])))) P.line('axis', [uMin - 45, v], [uMax + 45, v]);
}

/** END-ON bolt glyph: a plain regular hexagon at the pack face NEAREST the viewer, across-
 * corners = e -- the bare-hexagon glyph family (no washer/hole/shank circle, no
 * cross-hairs). `clip:'whole'` because a
 * compact hexagon reads better all-or-nothing than ragged partial clipping. */
function drawBoltGlyphsEndOn(
  P: Painter, grid: BoltGrid, pack: { axis: Vec3; minT: number; maxT: number },
  tmpl: BoltTemplate, viewName: string,
) {
  const { axis } = pack;
  // whichever pack face has the HIGHER projection onto the view's own normal is nearer the viewer
  const faceT = dot(axis, P.normal) >= 0 ? pack.maxT : pack.minT;
  const ref: Vec3 = Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const ex = norm(cross(ref, axis));
  const ey = cross(axis, ex);
  const R6 = tmpl.e / 2;
  for (const pos of grid.positions) {
    const a0 = dot(pos, axis);
    const facePoint = add(pos, scale(axis, faceT - a0));
    const hex: Vec3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      hex.push(add(facePoint, add(scale(ex, R6 * Math.cos(a)), scale(ey, R6 * Math.sin(a)))));
    }
    P.poly3d('bolt', viewName, hex, { closed: true, clip: 'whole' });
  }
}

/** SIDE-ON bolt assembly (head - shank - washer - nut along the bolt's own axis), all as
 * poly3d so occlusion clips the shank exactly where it enters the plate pack -- the house
 * convention (the buried portion is OMITTED, never dashed). `crossAxis` is a unit vector
 * perpendicular to the bolt axis, lying in the view plane (the view's own `v`), giving the
 * assembly's drawn width. Head/washer/nut are compact (`clip:'whole'`); the shank is the only
 * element long enough to be genuinely partially occluded (`clip:'segment'`). */
function drawBoltGlyphsSideOn(
  P: Painter, grid: BoltGrid, pack: { axis: Vec3; minT: number; maxT: number },
  tmpl: BoltTemplate, crossAxis: Vec3, viewName: string,
) {
  const { axis, minT, maxT } = pack;
  const cross = norm(crossAxis);
  const headLo = minT - tmpl.k, headHi = minT;
  const washerLo = maxT, nutLo = washerLo + tmpl.washerT, nutHi = nutLo + tmpl.m;
  const shankHi = nutHi + tmpl.protrusion;
  const seen = new Set<string>();   // multiple bolt ROWS can share one (axis,cross) projection
  for (const pos of grid.positions) {
    const a0 = dot(pos, axis), c0 = dot(pos, cross);
    const key = `${Math.round(a0 * 10)},${Math.round(c0 * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = (t: number): Vec3 => add(pos, scale(axis, t - a0));
    const rect = (t0: number, t1: number, halfW: number): Vec3[] => [
      add(at(t0), scale(cross, -halfW)), add(at(t1), scale(cross, -halfW)),
      add(at(t1), scale(cross, halfW)), add(at(t0), scale(cross, halfW)),
    ];
    // head, with a centre line (a hex-across-corners side-on projection)
    P.poly3d('bolt', viewName, rect(headLo, headHi, tmpl.s / 2), { closed: true, clip: 'whole' });
    P.poly3d('bolt', viewName, [at(headLo), at(headHi)], { clip: 'whole' });
    // shank -- the only element long enough to be genuinely partially occluded
    P.poly3d('bolt', viewName,
      [add(at(headHi), scale(cross, -tmpl.d / 2)), add(at(shankHi), scale(cross, -tmpl.d / 2))],
      { clip: 'segment' });
    P.poly3d('bolt', viewName,
      [add(at(headHi), scale(cross, tmpl.d / 2)), add(at(shankHi), scale(cross, tmpl.d / 2))],
      { clip: 'segment' });
    // washer
    P.poly3d('bolt', viewName, rect(washerLo, nutLo, tmpl.washerOD / 2), { closed: true, clip: 'whole' });
    // nut, with a centre line
    P.poly3d('bolt', viewName, rect(nutLo, nutHi, tmpl.s / 2), { closed: true, clip: 'whole' });
    P.poly3d('bolt', viewName, [at(nutLo), at(nutHi)], { clip: 'whole' });
  }
}

/** TRUE rolled I-profile cross-section from the SECTION TABLE, centred on `c` (paper mm),
 * width B along u, depth H along v, including the web-to-flange ROOT FILLET arcs.
 *
 * This must come from the section properties, not the IFC: the IDEA export ships every
 * UN-CUT member as a plain 24-vertex BOX (verified on HEA550A/HEA260/HEA160), so a member
 * seen end-on would otherwise read as a bare rectangle. The house style draws the real
 * profile with its fillets (radius = the IOM's own `r2`, e.g. r=24 on HEA260, r=27 on
 * HEA550A), because the rolled shape is fabrication-relevant. */
function drawIProfile(P: Painter, params: Record<string, number>, c: Pt, layer = 'visible') {
  const B = params.B ?? 0, H = params.H ?? 0;
  if (!B || !H) return;
  const tw = params.s ?? 0, tf = params.t ?? 0, r = params.r2 ?? 0;
  const b = B / 2, h = H / 2, w = tw / 2;
  const fy = h - tf;              // flange underside (top); mirrored for the bottom
  const X = (x: number) => c[0] + x, Y = (y: number) => c[1] + y;
  const pl = (pts: [number, number][]) => P.poly(layer, false, pts.map(([x, y]) => [X(x), Y(y)] as Pt));
  // flange outer U-shapes (top + bottom)
  pl([[-b, fy], [-b, h], [b, h], [b, fy]]);
  pl([[-b, -fy], [-b, -h], [b, -h], [b, -fy]]);
  // flange undersides, out to where the fillet starts
  pl([[b, fy], [w + r, fy]]);
  pl([[-b, fy], [-(w + r), fy]]);
  pl([[b, -fy], [w + r, -fy]]);
  pl([[-b, -fy], [-(w + r), -fy]]);
  // web faces, between the fillet tangent points
  pl([[w, fy - r], [w, -(fy - r)]]);
  pl([[-w, fy - r], [-w, -(fy - r)]]);
  // four root fillets (tangent to flange underside and web face)
  if (r > 0) {
    P.arc(layer, [X(w + r), Y(fy - r)], r, 90, 180);
    P.arc(layer, [X(-(w + r)), Y(fy - r)], r, 0, 90);
    P.arc(layer, [X(w + r), Y(-(fy - r))], r, 180, 270);
    P.arc(layer, [X(-(w + r)), Y(-(fy - r))], r, 270, 360);
  }
}

/** Bolt symbol (washer + hex nut + hole + shank, 4 concentric elements per position) plus
 * dash-dot gauge centrelines through every row/column. This is the OLDER concentric-circle
 * convention -- still used by FRONT VIEW (see buildDrawing), which deliberately keeps its
 * bolt grid UNCLIPPED: the bolts there sit genuinely behind the bearing member's web, and
 * honest occlusion would delete the whole grid along with the plate-edge/gauge dimension
 * chains anchored to it. The end-plate archetype's SECTION/END-PLATE views use the bare-hexagon
 * + occlusion-clipped glyph family instead (drawBoltGlyphsEndOn/SideOn below). */
function drawBoltGrid(P: Painter, grid: BoltGrid, boltDims: BoltDims | undefined, holeR: number) {
  const d = grid.assembly ? grid.assembly.diameter : 20;
  const washerR = 0.925 * d;   // washer OD ~= 1.85*d (ISO 7089): M20->37, M16->30, M24->44
  const hex = boltDims?.get(Math.round(d));
  const hexR = hex ? hex.e / 2 : washerR * 0.98;   // hex across-corners/2 (just inside washer)
  const shankR = d / 2;
  for (const pos of grid.positions) {   // bolt = washer + hex nut + hole + shank (4 elems)
    const c = P.p(pos);
    P.circle('bolt', c, washerR);            // washer (outermost)
    P.poly('bolt', true, hexPts(c, hexR));   // hex nut (EN 14399), corners just inside washer
    P.circle('bolt', c, holeR);              // hole (Ø borehole)
    P.circle('bolt', c, shankR);             // bolt shank (Ø diameter)
  }
  drawBoltAxisLines(P, grid);
}

/** Resolve a Weld.connectedPartIds entry (e.g. "Plate10", "Beam2", or a bare "1") to the
 * model Member/Plate it references. IOM id-strings are an optional type prefix + the
 * numeric id; the prefix varies by exporter (seen: "Plate7", "Beam2", plain "1"). */
function resolveConnPart(id: string, model: ConnectionModel):
  { kind: 'member'; obj: Member } | { kind: 'plate'; obj: Plate } | undefined {
  const n = Number(id.match(/(\d+)\s*$/)?.[1]);
  if (!Number.isFinite(n)) return undefined;
  if (/plate/i.test(id)) {
    const p = model.plates.find((pl) => pl.id === n);
    return p ? { kind: 'plate', obj: p } : undefined;
  }
  const mem = model.members.find((mm) => mm.id === n);
  return mem ? { kind: 'member', obj: mem } : undefined;
}

/** A member's own "end plate" (a cap welded around its section, e.g. an IDEA "End Plate"
 * component) as opposed to a fin/gusset plate welded flat against one face. Signalled by
 * the IDEA-native weld-name marker "EndPlate" (the operation that created the weld) --
 * this is a known fragile point if a different exporter phrases it differently; a more
 * robust structured signal should replace it if that surfaces. Returns the plate with the
 * most such welds to this member (a real cap is welded around multiple faces). */
function memberEndPlate(model: ConnectionModel, mem: Member): Plate | undefined {
  const hits = new Map<number, number>(); // plate.id -> weld count
  for (const w of model.welds) {
    if (!/EndPlate/i.test(w.name)) continue;
    const parts = w.connectedPartIds.map((id) => resolveConnPart(id, model));
    if (!parts.some((p) => p?.kind === 'member' && p.obj.id === mem.id)) continue;
    for (const p of parts) if (p?.kind === 'plate') hits.set(p.obj.id, (hits.get(p.obj.id) ?? 0) + 1);
  }
  let best: { id: number; count: number } | undefined;
  for (const [id, count] of hits) if (!best || count > best.count) best = { id, count };
  return best ? model.plates.find((p) => p.id === best!.id && !p.isNegative) : undefined;
}

/** The member-axis point nearest the connection origin (t=0 projection of the axis line). */
function nearestAxisPoint(mem: Member): Vec3 {
  const dir = norm(sub(mem.axis!.end, mem.axis!.start));
  return add(mem.axis!.start, scale(dir, -dot(mem.axis!.start, dir)));
}

/** Bolted END-PLATE archetype: the bolt grid clamps two PLATES together (each welded as a
 * cap on its own member), as opposed to a fin/gusset plate bolted to a member's web. The
 * archetype decides the whole view set -- notably which SECTION cut is taken. */
function isEndPlateConnection(grid: BoltGrid | undefined): boolean {
  return !!grid && grid.connectedParts.length > 1
    && grid.connectedParts.every((c) => /plate/i.test(c.type));
}

/** JOINT SECTION for the end-plate archetype: cut looking along the BEARING member's own
 * axis, so the bearing member reads as a TRUE cross-section while the carried member, its
 * stub and the bolted plates read in side elevation (the bearing member drawn at its full
 * B x H with its root fillets, the carried member with its flange lines, the plates edge-on).
 *
 * This is deliberately a DIFFERENT cut from the fin-plate archetype's horizontal/plan
 * section: a shear tab's unknown is the through-thickness stack (best seen in plan), while
 * an end-plate joint's unknown is how the incoming member's section meets the bearing
 * member's section (best seen along the bearing axis). */
function buildBearingAxisSection(
  model: ConnectionModel, bearing: Member, grid: BoltGrid | undefined, boltDims: BoltDims | undefined,
  ox: number, oy: number, num: string, frame?: Frame,
): { view: ViewDef; entities: Entity[] } | undefined {
  if (!bearing.axis || !bearing.section) return undefined;
  // The frame comes from the view PLAN (feature-derived; see viewplan.ts). The fallback below is
  // the older hand-built basis, kept only for a direct call without a plan -- note it needed a
  // special case for a vertical bearing member precisely because it was pinned to global Z.
  const Zc: Vec3 = { x: 0, y: 0, z: 1 };
  const dir = norm(sub(bearing.axis.end, bearing.axis.start));
  const vertical = Math.abs(dot(dir, Zc)) > 0.9;
  const u = frame?.u ?? (vertical ? { x: 1, y: 0, z: 0 } : norm(cross(dir, Zc)));
  const v = frame?.v ?? (vertical ? { x: 0, y: 1, z: 0 } : Zc);
  const origin = frame?.origin ?? nearestAxisPoint(bearing);
  const P = new Painter({ origin, u, v }, ox, oy);
  const L = (lu: number, lv: number): Pt => [lu + ox, lv + oy];

  // bearing member is genuinely CUT by this section plane -> `cut`, not `visible`
  // (the carried members below are in side ELEVATION here, not cut, so they stay `visible`).
  drawIProfile(P, bearing.section.params, L(0, 0), 'cut');
  const bH = bearing.section.params.H ?? 0, bB = bearing.section.params.B ?? 0;

  // carried members (+ stubs) are in side elevation: the IFC gives their outer box outline,
  // so add the flange lines the box lacks (an un-cut member is a 24-vertex box -- no profile).
  for (const mem of model.members) {
    if (mem === bearing || !mem.axis || !mem.section) continue;
    const H = mem.section.params.H ?? 0, tf = mem.section.params.t ?? 0;
    if (!H || !tf) continue;
    const a = P.p(mem.axis.start), b = P.p(mem.axis.end);
    const uLo = Math.min(a[0], b[0]), uHi = Math.max(a[0], b[0]);
    const axisV = (a[1] + b[1]) / 2;
    for (const s of [1, -1]) {
      const vf = axisV + s * (H / 2 - tf);
      P.line('visible', [uLo, vf], [uHi, vf]);
    }
    P.line('axis', [uLo - 30, axisV], [uHi + 30, axisV]);
  }
  // bolts run along u here (the grip through both plates), seen SIDE-ON: head-shank-washer-nut
  // via the side-on glyph convention, occlusion-clipped so the buried shank span disappears
  // instead of being drawn through the plate pack. A short `axis` tick per distinct projected
  // position marks each row (multiple bolt ROWS can share one (u,v) point in this frame, since
  // u is perpendicular to the bearing axis but not to the grid's own row axis -- dedupe or the
  // tick is drawn twice).
  if (grid?.assembly) {
    const pack = boltPack(model, grid);
    if (pack) drawBoltGlyphsSideOn(P, grid, pack, boltTemplate(grid.assembly.diameter, boltDims), v, 'SECTION A-A');
    const seenBolt = new Set<string>();
    for (const pos of grid.positions) {
      const c = P.p(pos);
      const key = `${R(c[0])},${R(c[1])}`;
      if (seenBolt.has(key)) continue;
      seenBolt.add(key);
      P.line('axis', [c[0] - 60, c[1]], [c[0] + 60, c[1]]);
    }
  }
  // AXIAL CHAIN across the bolted stack -- the same chain the plan draws, from the same helper,
  // because it measures the same real thing seen from another direction. Drawing only the plate
  // THICKNESSES here (which is what this used to do) printed `10 | 10` and silently dropped both
  // the 1mm erection gap between the plates and the 180 from the pack to the bearing member's web
  // centreline -- two numbers the fabricator needs (docs 8.12/D9).
  axialStationChain(P, model, bearing, ox, oy + bH / 2, oy + bH / 2 + 150);

  P.line('axis', L(0, -bH / 2 - 60), L(0, bH / 2 + 60));   // bearing member centreline
  labelLeader(P, L(bB / 2 - 10, bH / 2 - 10), L(bB / 2 + 78, bH / 2 + 42),
    H_LABEL, memberLabel(bearing), 'left');
  // EVERY member and plate in the cut gets its own label, not just the bearing one. A two-plate
  // joint with a stub needs five (member + stub, two plates, bearing member) where we drew one --
  // a fabricator reading this view could not tell which profile the incoming stub was (docs 8.12/D7).
  labelCarriedAndPlates(P, model, bearing, ox, oy);
  // WELD SYMBOLS. A joint section must carry the joint's welds (typically a bevel/PJP and a
  // fillet); we carried none, because weld symbols were only ever emitted in the FRONT VIEW and the
  // per-member END PLATE view. A joint section is exactly where the weld between the incoming stub
  // and the bearing member is clearest, which is the usual drafting criterion: indicate the same
  // weld only once, in the clearest view.
  const secWelds = model.welds.filter((w) => !/EndPlate/i.test(w.name));
  if (secWelds.length) {
    const wm = [...secWelds].sort((a, b) => wlen(b) - wlen(a))[0]!;
    const a = P.p(wm.start), b = P.p(wm.end);
    weldSymbol(P, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], wm.type, wm.thickness, 'left', 300);
  }
  viewTitle(P, L(-140, -bH / 2 - 190), num, 'SECTION A-A', '1:10', TITLE_STYLE);

  const others = model.members.filter((m) => m !== bearing).map((m) => m.name);
  const plateNames = model.plates.filter((p) => !p.isNegative).map((p) => p.name);
  return {
    view: {
      name: 'SECTION A-A', num,
      origin: [origin.x, origin.y, origin.z], u: [u.x, u.y, u.z], v: [v.x, v.y, v.z],
      ox, oy, crop: [520, 400], hlr: true, minLen: 3, noTitle: true,
      parts: [...others, ...plateNames],   // bearing member is drawn parametrically instead
      // BOLT OCCLUSION must NOT use the carried members' own IFC meshes: those ship as a
      // single un-cut B x H box with no flange/web distinction (see memberOccluders), so a
      // bolt sitting in the open space BETWEEN flanges reads as "inside the box" and the
      // whole shank vanishes. Restrict occlusion to the PLATE meshes (real, holed) and let
      // spec.occluders (the parametric flange/web boxes) cover every member instead.
      clipParts: plateNames,
    },
    entities: P.entities,
  };
}

/** Running dimension chain along `u` across the bolted stack: every plate FACE plus the bearing
 * member's own web centreline (which projects to this frame's origin, u = ox). Consecutive
 * stations become one dim each, so a two-plate joint reads `10 | 1 | 10 | 180` -- plate, erection
 * gap, plate, pack-to-web-centreline -- straight from the model, never a hardcoded station list.
 *
 * Shared by the PLAN and the joint SECTION deliberately: both cut the same stack along the same
 * axis and must print the same numbers. When each built its own chain, the section's version had
 * quietly degenerated into per-plate thickness dims only.
 *
 * `vAt` is where the chain's witness lines start (on the geometry) and `vDim` where its dimension
 * line sits. Returns the sorted stations so a caller can place a label at the pack's midpoint.
 *
 * Returns [] when the stack has NO extent along `u` in this frame -- i.e. the plate normal lies in
 * the view plane perpendicular to `u`, or along the view normal. Every station then collapses onto
 * `ox` and there is nothing to chain. That is not a corner case: a COLLINEAR end-plate splice
 * (both members on one axis, plate normal along that axis) hits it in the PLAN, where the pack is
 * seen edge-on across `v` instead. Callers must treat [] as "this view does not measure the stack",
 * not as an error -- and must not derive positions from it (Math.min(...[]) is Infinity). */
function axialStationChain(
  P: Painter, model: ConnectionModel, bearing: Member, ox: number, vAt: number, vDim: number,
): number[] {
  const plates = model.plates.filter((p) => !p.isNegative);
  if (!plates.length) return [];
  const stations = [ox];   // the bearing member's web centreline IS this frame's origin
  for (const pl of plates) {
    const { a, b } = plateFaces(pl);
    stations.push(P.p(a)[0], P.p(b)[0]);
  }
  const uniq = [...new Set(stations.map((s) => R(s)))].sort((x, y) => x - y);
  if (uniq.length < 2) return [];
  for (let i = 0; i < uniq.length - 1; i++)
    P.dim('dimension', [uniq[i]!, vAt], [uniq[i + 1]!, vAt], [uniq[i]!, vDim], 0);
  return uniq;
}

/** Label every CARRIED member and every plate visible in a joint section, in addition to the
 * bearing member the caller labels itself. A joint section carries a label per
 * distinct piece -- including two `HEA160`s, because a member and its stub are different PIECES
 * that happen to share a profile, so collapsing them would hide that there are two.
 *
 * Positions are nominal: each label is anchored on the feature it names and given a starting slot
 * outside the geometry, then the Python side nudges it clear of whatever it collides with (see the
 * `label` entity). That is why no clever placement maths is needed here -- and why a fixed slot,
 * which is what the single bearing-member label used to rely on, is not required to be right. */
function labelCarriedAndPlates(P: Painter, model: ConnectionModel, bearing: Member, ox: number, oy: number) {
  for (const mem of model.members) {
    if (mem === bearing || !mem.axis || !mem.section) continue;
    const H = mem.section.params.H ?? 0;
    const a = P.p(mem.axis.start), b = P.p(mem.axis.end);
    const uLo = Math.min(a[0], b[0]), uHi = Math.max(a[0], b[0]);
    const axisV = (a[1] + b[1]) / 2;
    // anchor on the member's own top flange, a little in from its far end so the leader crosses
    // empty space rather than running along the flange it points at
    const anchor: Pt = [uLo + (uHi - uLo) * 0.78, axisV + H / 2];
    P.label('text', [anchor[0] + 150, anchor[1] + 130], H_LABEL, memberLabel(mem), anchor, 'left');
  }
  for (const pl of model.plates.filter((p) => !p.isNegative)) {
    if (Math.abs(pl.thickness - Math.round(pl.thickness)) > 0.05) continue;  // house prints integer mm
    const { a, b } = plateFaces(pl);
    const f0 = P.p(a), f1 = P.p(b);
    const mid: Pt = [(f0[0] + f1[0]) / 2, (f0[1] + f1[1]) / 2];
    P.label('text', [mid[0] - 220, mid[1] - 190], H_LABEL, `PL ${Math.round(pl.thickness)}`,
      mid, 'left');
  }
}

/** Per-member END-PLATE SECTION: a supplementary view looking straight down the member's
 * OWN axis (member-locked frame, not a hardcoded global axis), restricted to just that
 * member + its own welded end plate + the shared bolt grid -- the "which face, which
 * holes" detail a stub/end-plate connection needs (distinct from a fin-plate connection's
 * plan section). Returns undefined if the member has no true end plate or lacks geometry. */
function buildEndPlateSection(
  model: ConnectionModel, mem: Member, plate: Plate, grid: BoltGrid | undefined,
  boltDims: BoltDims | undefined, holeR: number, ox: number, oy: number, num: string,
  frame?: Frame,
): { view: ViewDef; entities: Entity[] } | undefined {
  if (!mem.axis || !mem.sectionFrame || !mem.section) return undefined;
  // frame from the view PLAN; the member's own section frame is the fallback (it is already
  // feature-derived, so the two agree for a square connection)
  const origin = frame?.origin ?? nearestAxisPoint(mem);
  const u = frame?.u ?? mem.sectionFrame.vy, v = frame?.v ?? mem.sectionFrame.vz;
  const P = new Painter({ origin, u, v }, ox, oy);
  const { B, H } = mem.section.params;
  // P.p() projects a 3D model point into paper space (adds ox/oy); these dims/labels are
  // laid out directly in the member's own LOCAL (u,v) frame instead, so they need the same
  // ox/oy shift applied by hand -- L() is that local-frame -> paper-space conversion.
  const L = (lu: number, lv: number): Pt => [lu + ox, lv + oy];

  // the member is seen END-ON here, so draw its TRUE rolled profile from the section table
  // (the IFC ships un-cut members as boxes -- see drawIProfile). The view's `parts` filter
  // below therefore excludes the member, leaving only the end plate to the IFC pass. This
  // member IS the thing the section plane cuts through -> `cut` (the plate beside it is
  // seen face-on, not cut, and stays `visible` via the IFC pass).
  drawIProfile(P, mem.section.params, L(0, 0), 'cut');
  // bolts seen END-ON here (looking down this member's own axis, same as the bolt axis): the
  // bare-hexagon glyph family -- a plain hexagon, occlusion-clipped -- via drawBoltGlyphsEndOn.
  if (grid) {
    drawBoltAxisLines(P, grid);
    if (grid.assembly) {
      const pack = boltPack(model, grid);
      if (pack) {
        drawBoltGlyphsEndOn(P, grid, pack, boltTemplate(grid.assembly.diameter, boltDims),
          `${mem.name} END PLATE`);
      }
    }
  }
  const epWeld = model.welds.find((w) => {   // one representative weld connecting this member+plate
    if (!/EndPlate/i.test(w.name)) return false;
    const parts = w.connectedPartIds.map((id) => resolveConnPart(id, model));
    return parts.some((p) => p?.kind === 'member' && p.obj.id === mem.id)
      && parts.some((p) => p?.kind === 'plate' && p.obj.id === plate.id);
  });
  if (epWeld) {
    // anchor at the profile's own bottom-left corner (stable in this frame) rather than the
    // raw weld line's projection -- a fixed reach (260mm) that reads fine on a full elevation
    // would fly off past a small end-plate section's own geometry.
    weldSymbol(P, L(-B / 2, -H / 2), epWeld.type, epWeld.thickness, 'left', 90);
  }
  // dimension chains across the member's own section, from the bolt grid (edge/gauge/edge,
  // edge/pitch.../edge) exactly like the front-view chains, just in this member's own frame
  if (grid) {
    const b2 = grid.positions.map((p) => P.p(p));
    const cols = [...new Set(b2.map((p) => Math.round(p[0] - ox)))].sort((a, b) => a - b);
    const rows = [...new Set(b2.map((p) => Math.round(p[1] - oy)))].sort((a, b) => a - b);
    const uMin = -B / 2, uMax = B / 2, vMin = -H / 2, vMax = H / 2;
    const chainU = [uMin, ...cols, uMax];
    for (let i = 0; i < chainU.length - 1; i++)
      P.dim('dimension', L(chainU[i]!, vMax), L(chainU[i + 1]!, vMax), L(chainU[i]!, vMax + 70), 0);
    const chainV = [vMin, ...rows, vMax];
    for (let i = 0; i < chainV.length - 1; i++)
      P.dim('dimension', L(uMin - 70, chainV[i]!), L(uMin - 70, chainV[i + 1]!), L(uMin - 70, chainV[i]!), 90);
  }
  P.label('text', L(0, H / 2 + 210), H_LABEL, memberLabel(mem), L(0, H / 2), 'center');
  labelLeader(P, L(B / 2 + 8, 0), L(B / 2 + 76, 6), H_LABEL,
    `PL ${Math.round(plate.thickness)}`, 'left');
  if (grid?.assembly) {
    const bc = centroid(grid.positions.map((p) => P.p(p)));
    P.text('text', [B / 2 + 70 + ox, bc[1] - 60], H_LABEL,
      `${grid.positions.length} x M${Math.round(grid.assembly.diameter)} (${normalizeGrade(grid.assembly.grade)})`, 'left');
  }
  // numbered view title, drawn HERE rather than by the Python side (noTitle) so it uses the
  // same callout-bubble convention as the joint section instead of a bare centred caption.
  // The title carries the member's PIECE MARK (not its section): two different pieces can share
  // one profile -- e.g. a member and its stub, both HEA160 -- so only the mark tells them apart.
  // The profile designation is labelled on the geometry inside the view instead.
  viewTitle(P, L(-B / 2 - 20, -H / 2 - 210), num, `${mem.name} END PLATE`, '1:10', TITLE_STYLE);
  const crop: [number, number] = [B / 2 + 60, H / 2 + 260];
  return {
    view: {
      name: `${mem.name} END PLATE`, num,
      origin: [origin.x, origin.y, origin.z], u: [u.x, u.y, u.z], v: [v.x, v.y, v.z],
      ox, oy, crop, hlr: true, noTitle: true, parts: [plate.name],
    },
    entities: P.entities,
  };
}

// ---- SECTION MARKS: drawing the view TREE ------------------------------------------------------
// The mark is one glyph family (docs 8.9), sized by profile section_mark.*:
//   * a continuous section LINE spanning the parent view (`text` role, not `axis` -- it is an
//     annotation, not a centreline);
//   * a BUBBLE (section_mark.bubble_r) just beyond one end, carrying the CHILD view's number. Note
//     this is a different radius from the view-TITLE bubble (view_title.bubble_r): two sizes, two meanings;
//   * a solid ARROW hugging that bubble, pointing in the direction of sight;
//   * a small solid TICK at the far end (section_mark.tick_len / tick_w).
// The arrow's six points, relative to the bubble centre with `s` = sight direction, `t` =
// perpendicular, i = section_mark.arrow_in and o = section_mark.arrow_out:
//   c-o*t, c-i*t, c+i*s, c+i*t, c+o*t, c+o*s
const MARK_R = STYLE.section_mark.bubble_r;          // section-mark bubble radius (not the view title's)
const MARK_ARROW_IN = STYLE.section_mark.arrow_in;   // arrow's inner notch, hugging the bubble
const MARK_ARROW_OUT = STYLE.section_mark.arrow_out; // arrow's tip and its half-width
const MARK_TICK_LEN = STYLE.section_mark.tick_len;   // far-end tick: along the sight direction
const MARK_TICK_W = STYLE.section_mark.tick_w;       // far-end tick: across it

/** Where a child SECTION's cut plane appears inside its PARENT view, as a 2D line in the parent's
 * paper coordinates, plus the direction of sight.
 *
 * The cut plane is {p : (p - o_s) . n_s = 0}. Writing n_s in the parent's basis gives
 * n_s = alpha*u_p + beta*v_p + gamma*n_p, and gamma is ZERO precisely because the planner only
 * assigns a parent whose view plane contains n_s (isPerp). So the plane projects to the straight
 * line alpha*a + beta*b + c = 0 in the parent's local (a,b), with c = (o_p - o_s) . n_s. Any
 * gamma != 0 would mean the cut plane crosses the parent's plane obliquely and could not be drawn
 * as a single straight mark at all -- which is why the tree is built on that test.
 */
function cutLineInParent(
  child: { frame: { origin: Vec3 }; normal: Vec3 },
  parent: { frame: { origin: Vec3; u: Vec3; v: Vec3 }; ox: number; oy: number; crop?: [number, number] },
): { a: Pt; b: Pt; sight: [number, number]; dir: [number, number] } | undefined {
  const ns = norm(child.normal);
  const alpha = dot(ns, parent.frame.u), beta = dot(ns, parent.frame.v);
  const m = Math.hypot(alpha, beta);
  if (m < 1e-6) return undefined;   // the cut plane is parallel to the parent's plane: no line
  const c = dot(sub(parent.frame.origin, child.frame.origin), ns);
  // closest point of the line to the parent's local origin, then into paper coordinates
  const p0: Pt = [(-c * alpha) / (m * m) + parent.ox, (-c * beta) / (m * m) + parent.oy];
  const dir: [number, number] = [-beta / m, alpha / m];         // along the line
  // The viewer of the child sits on its +normal side and looks along -normal (see ifc_geom's depth
  // convention), so the mark's arrow -- which by drafting convention points the way you look --
  // runs along -(alpha, beta).
  const sight: [number, number] = [-alpha / m, -beta / m];
  // length: span the parent's cropped extent along the line, with a little (15%) overshoot
  // past the view on both sides
  const [cu, cv] = parent.crop ?? [470, 470];
  const half = 1.15 * (Math.abs(dir[0]) * cu + Math.abs(dir[1]) * cv);
  return {
    a: [p0[0] - dir[0] * half, p0[1] - dir[1] * half],
    b: [p0[0] + dir[0] * half, p0[1] + dir[1] * half],
    sight, dir,
  };
}

/** The full section mark for `childNum`, drawn into the parent view's paper space. */
function sectionMarkEntities(
  childNum: string,
  child: { frame: { origin: Vec3 }; normal: Vec3 },
  parent: { frame: { origin: Vec3; u: Vec3; v: Vec3 }; ox: number; oy: number; crop?: [number, number] },
): Entity[] {
  const g = cutLineInParent(child, parent);
  if (!g) return [];
  const L = 'text';
  const out: Entity[] = [];
  // Which end carries the bubble is a LAYOUT choice, not geometry; pick deterministically (the
  // end that is higher on the sheet, then further right) so the same model always draws the same
  // mark. On a vertical cut line that is the upper end.
  const [hi, lo] = (g.b[1] > g.a[1] || (g.b[1] === g.a[1] && g.b[0] > g.a[0])) ? [g.b, g.a] : [g.a, g.b];
  const away: [number, number] = [hi[0] - lo[0], hi[1] - lo[1]];
  const an = Math.hypot(away[0], away[1]) || 1;
  const outward: [number, number] = [away[0] / an, away[1] / an];

  out.push({ type: 'line', layer: L, start: rp(lo), end: rp(hi) });

  const c: Pt = [hi[0] + outward[0] * MARK_R, hi[1] + outward[1] * MARK_R];
  out.push({ type: 'circle', layer: L, center: rp(c), r: MARK_R });

  const [sx, sy] = g.sight;
  const tx = -sy, ty = sx;      // perpendicular to the sight direction
  const at = (ds: number, dt: number): Pt => [c[0] + sx * ds + tx * dt, c[1] + sy * ds + ty * dt];
  out.push({ type: 'hatch', layer: L, solid: true, boundary: [
    at(0, -MARK_ARROW_OUT), at(0, -MARK_ARROW_IN), at(MARK_ARROW_IN, 0),
    at(0, MARK_ARROW_IN), at(0, MARK_ARROW_OUT), at(MARK_ARROW_OUT, 0),
  ].map(rp) });

  // far-end tick, laid off the line's other end along the sight direction
  const e = lo;
  out.push({ type: 'hatch', layer: L, solid: true, boundary: ([
    e,
    [e[0] + sx * MARK_TICK_LEN, e[1] + sy * MARK_TICK_LEN],
    [e[0] + sx * MARK_TICK_LEN - tx * MARK_TICK_W, e[1] + sy * MARK_TICK_LEN - ty * MARK_TICK_W],
    [e[0] - tx * MARK_TICK_W, e[1] - ty * MARK_TICK_W],
  ] as Pt[]).map(rp) });

  // the id, centred in the bubble and rotated to the cut line so it reads with the sheet straight
  let rot = (Math.atan2(g.dir[1], g.dir[0]) * 180) / Math.PI;
  rot = ((rot % 180) + 180) % 180;                 // 0..180: never upside-down
  out.push({ type: 'text', layer: L, pos: rp(c), height: H_LABEL, text: childNum,
             align: 'center', rotation: rot });
  return out;
}

/** `units` is the DOCUMENT's unit base, not the unit these coordinates are in: everything below
 * is canonical millimetres and server/render.py applies the base once (see DrawingSpec.meta). */
export function buildDrawing(
  m: ConnectionModel, boltDims?: BoltDims, units: 'mm' | 'cm' = 'mm',
  titleStyle: 'bubble' | 'underline' = 'bubble',
): DrawingSpec {
  TITLE_STYLE = titleStyle;   // house policy for this build (see TITLE_STYLE)
  const plate = m.plates.find((p) => !p.isNegative);
  const grid = m.boltGrids[0];
  const holeR = grid?.assembly ? grid.assembly.borehole / 2 : 11;
  const X: Vec3 = { x: 1, y: 0, z: 0 }, Y: Vec3 = { x: 0, y: 1, z: 0 }, Z: Vec3 = { x: 0, y: 0, z: 1 };
  const O: Vec3 = { x: 0, y: 0, z: 0 };

  // ---- WHICH VIEWS, AND WHY (see viewplan.ts) --------------------------------------------------
  // The view set is no longer a hand-written list: a template proposes the archetype's preferred
  // frames and an information-coverage pass checks that between them they can carry every
  // fabrication dimension the model implies, adding a view or raising a flag when they cannot.
  // Frames come out FEATURE-DERIVED, which is what the old global `u: Y, v: Z` could never be:
  // that only pointed the right way when the connection happened to be axis-aligned.
  //
  // Expected view sets: a fin plate plans 1 main + 1 section + isometric = 3 views, and an end
  // plate 1 main + 2 sections + isometric = 4. Note the end-plate plan does NOT include a FRONT
  // VIEW: the PLAN and the two sections already cover everything it would have shown, which is
  // why we used to emit 5 views where 4 suffice.
  const bearing = m.members.find((mm) => mm.isBearing && mm.section) ?? m.members.find((mm) => mm.section);
  const endPlate = isEndPlateConnection(grid);   // archetype decides which SECTION cut is right
  const archetype: Archetype = endPlate ? 'end-plate' : 'fin-plate';
  const jointOrigin = bearing?.axis ? nearestAxisPoint(bearing) : O;
  const plan: Plan = planViews(m, archetype, bearing, jointOrigin);
  const planOf = (name: string): PlannedView | undefined => plan.views.find((v) => v.name === name);

  // ---- MAIN/FRONT VIEW: looks along the bolt axis for a fin plate (plate face-on, bolt pattern
  // true-shape). Only built when the plan asks for it.
  const front = planOf('FRONT VIEW');
  const P1 = new Painter(front ? front.frame : { origin: O, u: Y, v: Z }, 0, 0);
  for (const mem of m.members) drawMember(P1, mem);
  if (grid) drawBoltGrid(P1, grid, boltDims, holeR);
  // PRIMARY welds only: the per-face "EndPlate" cap fillets (welding a member into its own end
  // plate) are already annotated in buildEndPlateSection -- picking from them here too just
  // steals the front-view symbol slot from the connection's own actual member-to-plate welds
  // (e.g. it silently hid a real Bevel/PJP weld tied in length with an EndPlate fillet).
  const primaryWelds = m.welds.filter((w) => !/EndPlate/i.test(w.name));
  const weldPool = primaryWelds.length ? primaryWelds : m.welds;
  if (weldPool.length) {
    const wm = [...weldPool].sort((a, b) => wlen(b) - wlen(a))[0]!;   // main (longest) weld -> left
    const a = P1.p(wm.start), b = P1.p(wm.end);
    weldSymbol(P1, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], wm.type, wm.thickness, 'left');
    const wb = [...weldPool].sort(  // lowest weld -> bottom symbol
      (a, b) => (P1.p(a.start)[1] + P1.p(a.end)[1]) - (P1.p(b.start)[1] + P1.p(b.end)[1]))[0]!;
    const c = P1.p(wb.start), d = P1.p(wb.end);
    weldSymbol(P1, [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2], wb.type, wb.thickness, 'bottom');
  }
  // ---- dimensions (first pass) + labels ----
  if (plate) {
    const pg = plateGlobal(plate).map((g) => P1.p(g));
    const xmin = Math.min(...pg.map((p) => p[0])), xmax = Math.max(...pg.map((p) => p[0]));
    const ymin = Math.min(...pg.map((p) => p[1])), ymax = Math.max(...pg.map((p) => p[1]));
    if (grid) {
      const b2 = grid.positions.map((p) => P1.p(p));
      const rows = [...new Set(b2.map((p) => Math.round(p[1])))].sort((a, b) => a - b);
      const cols = [...new Set(b2.map((p) => Math.round(p[0])))].sort((a, b) => a - b);
      const colU = cols[0]!, rowV = rows[rows.length - 1]!;
      for (let i = 0; i < rows.length - 1; i++)  // vertical bolt pitches, left of plate
        P1.dim('dimension', [colU, rows[i]!], [colU, rows[i + 1]!], [xmin - 70, rows[i]!], 90);
      const chainX = [xmin, ...cols, xmax];      // horizontal: edge / gauge / edge, above plate
      for (let i = 0; i < chainX.length - 1; i++)
        P1.dim('dimension', [chainX[i]!, rowV], [chainX[i + 1]!, rowV], [chainX[i]!, ymax + 70], 0);
    }
    // plate overall height (outer left) + width (outer top) — offset well clear of the chains
    P1.dim('dimension', [xmin, ymin], [xmin, ymax], [xmin - 210, ymin], 90);
    P1.dim('dimension', [xmin, ymax], [xmax, ymax], [xmin, ymax + 215], 0);
    // labels: PL below the plate (Python nudges it clear of any line, then leaders back to the
    // plate centre) -- a fixed interior slot lands on geometry for a small/buried end plate.
    const cu = (xmin + xmax) / 2;
    P1.text('text', [cu, ymin - 90], H_LABEL, `PL ${Math.round(plate.thickness)}`, 'center',
      { avoid: true, leader: [cu, ymin] });
    if (grid?.assembly) {
      const bc = centroid(grid.positions.map((p) => P1.p(p)));
      P1.text('text', [xmax + 90, bc[1]], H_LABEL,
        `${grid.positions.length} x M${Math.round(grid.assembly.diameter)} (${normalizeGrade(grid.assembly.grade)})`, 'left');
      P1.line('text', [xmax + 82, bc[1]], [bc[0], bc[1]]);
    }
  }
  // (view titles are placed by the Python side, under the IFC silhouettes)

  // ---- View 2: SECTION A-A = horizontal section / PLAN (look -Z) ----
  // Verified against the source DWG: SECTION A-A is a plan cut, u=Y (beam axis, right),
  // v=X (support axis, up). The support reads as a 300-wide (B) x length rectangle with
  // its web hidden under the flange; the beam frames in from the right showing its 150mm
  // flange WIDTH (not the 300 depth); the fin plate is edge-on between them. The part
  // outlines come from the IFC solids (added to the views list below); here we only add
  // the annotations (centrelines, bolts, labels, weld, dims), pre-projected in the SAME
  // frame + offset so they register on the silhouette.
  const dx = 1000;
  // fin-plate SECTION A-A looks onto the members' FLANGE FACE (a plan, for horizontal members):
  // that is what puts the plate edge-on so its thickness is measurable and drops each web into
  // dashes beneath its own flange. Measured on the source: HE550A drawn 300 wide with a 13 dashed
  // web and dims 10/10/20 (docs 8.14).
  const finSec = planOf('SECTION A-A');
  const P2 = new Painter(finSec && !endPlate ? finSec.frame : { origin: O, u: Y, v: X }, dx, 0);
  if (plate && grid && !endPlate) {
    const beamPartId = grid.connectedParts.find((c) => /beam/i.test(c.type))?.id;
    const beam = m.members.find((mm) => String(mm.id) === beamPartId && mm.section);
    const support = m.members.find((mm) => mm !== beam && mm.section);
    const t = plate.thickness;
    const colB = support?.section?.params.B ?? 300;              // support flange width (Y)
    const cols = [...new Set(grid.positions.map((p) => Math.round(p.y)))].sort((a, b) => a - b); // bolt Y-columns
    const L = (uY: number, vX: number): Pt => [uY + dx, vX];     // local (Y,X) -> paper

    // centrelines: support axis (vertical, Y=0) + beam axis (horizontal, X=0)
    P2.line('axis', L(0, -490), L(0, 490));
    P2.line('axis', L(-190, 0), L(500, 0));
    // bolts: 3 rows stack into one shank per Y-column (look -Z along the row spacing)
    for (const y of cols) {
      P2.line('bolt', L(y, -30), L(y, 40));                                   // shank (along X)
      P2.poly('bolt', true, [L(y - 11, -14), L(y + 11, -14), L(y + 11, -4), L(y - 11, -4)]); // head
    }
    // labels with leaders
    P2.text('text', L(colB / 2 + 55, 320), H_LABEL, support ? memberLabel(support) : '', 'left');
    P2.line('text', L(colB / 2 + 50, 312), L(colB / 2, 150));
    P2.text('text', L(410, 128), H_LABEL, beam ? memberLabel(beam) : '', 'left');
    P2.line('text', L(405, 122), L(320, 75));
    P2.text('text', L(225, -137), H_LABEL, `PL ${Math.round(t)}`, 'left');
    P2.line('text', L(220, -132), L(120, -9));
    // plate thickness dim "10" (X-extent of the plate = its thickness), vertical dim
    P2.dim('dimension', L(108, 4), L(108, 14), L(180, 9), 90);
    if (m.welds.length) {   // plate-to-support weld
      const wmain = [...m.welds].sort((a, b) => wlen(b) - wlen(a))[0]!;
      weldSymbol(P2, L(10, -70), wmain.type, wmain.thickness, 'bottom');
    }
    // (its view title is drawn further down, once this view's callout number has been allocated --
    // P2 is still in scope there and its entities are spread into the spec at the very end)
  }

  // ---- View 3: ISOMETRIC (silhouette drawn by Python; no TS annotations) ----
  const s2 = Math.SQRT2, s6 = Math.sqrt(6);
  // Members seen END-ON in the front view are drawn parametrically by drawMember (true rolled
  // profile from the section table), so they must be withheld from the IFC silhouette pass --
  // their 24-vertex box would otherwise overlay a full B x H rectangle on the profile.
  const frontNormal = front ? front.normal : norm(cross(Y, Z));
  const frontParts = [
    ...m.members.filter((mm) => !(mm.axis && mm.section && isIShape(mm.section.type)
      && Math.abs(dot(norm(sub(mm.axis.end, mm.axis.start)), frontNormal)) > 0.7)).map((mm) => mm.name),
    ...m.plates.filter((p) => !p.isNegative).map((p) => p.name),
  ];
  const views: ViewDef[] = [];
  const extraEntities: Entity[] = [];

  // ---- EMIT THE PLANNED VIEWS -----------------------------------------------------------------
  // Numbering follows the plan's own order (main first), so it stays stable and gap-free. Sheet
  // POSITION is still a fixed slot per view name: placement is a separate concern from selection,
  // and a house sheet layout is not derivable from the model.
  const SLOT: Record<string, [number, number]> = {
    PLAN: [1900, -1400], 'FRONT VIEW': [0, 0], 'SECTION A-A': [dx, 0], ISOMETRIC: [2300, 0],
    // per-member end-plate sections share the lower-left column

  };
  // HIERARCHICAL NUMBERING: the main view is "01" and every section is "01.N" in plan order --
  // note a section is numbered under the MAIN view even when its mark is drawn inside another
  // section (a mark sitting in view 01.1 still makes its child 01.2, not 01.1.1). The isometric
  // gets NO number at all.
  const MAIN_NUM = '01';
  let secNo = 0;
  const numFor = (pv: PlannedView): string =>
    pv.role === 'main' ? MAIN_NUM : pv.role === 'iso' ? '' : `${MAIN_NUM}.${++secNo}`;
  // A view coverage ADDED has no slot in the template layout, so give it its own column to the
  // right instead of letting it land on top of a templated view.
  let extraSlot = 0;
  const slotFor = (name: string): [number, number] =>
    // per-member end-plate sections share the lower-left column; anything else the plan invented
    // gets its own column to the right, so it cannot land on top of a templated view
    SLOT[name] ?? (name.endsWith('END PLATE') ? [0, -1400] : [3400 + 1200 * extraSlot++, -1400]);
  const asDef = (f: { origin: Vec3; u: Vec3; v: Vec3 }) => ({
    origin: [f.origin.x, f.origin.y, f.origin.z] as [number, number, number],
    u: [f.u.x, f.u.y, f.u.z] as [number, number, number],
    v: [f.v.x, f.v.y, f.v.z] as [number, number, number],
  });

  // paper placement per view name, remembered so the section marks can be drawn into the parent
  const placed = new Map<string, { ox: number; oy: number; crop?: [number, number] }>();
  for (const pv of plan.views) {
    const num = numFor(pv);
    const [ox, oy] = slotFor(pv.name);

    placed.set(pv.name, { ox, oy, crop: pv.name === 'FRONT VIEW' ? [470, 340] : [470, 470] });

    if (pv.role === 'iso') {
      // An isometric is an ORIENTATION aid, not a measured view, and the house style draws it
      // entirely solid: only `visible` + `bolt` lines, ZERO `hidden`. Ours came out 27 projection
      // + 30 hidden because `hlr` defaults to true.
      // It is also captioned, never bubbled, and carries no number -- under BOTH title policies.
      views.push({ name: 'ISOMETRIC', num: undefined, ...asDef(pv.frame), ox, oy,
                   interPartHlr: false, selfHlr: false, titleStyle: 'underline' });
      continue;
    }

    if (pv.name === 'FRONT VIEW') {
      views.push({ name: 'FRONT VIEW', num, ...asDef(pv.frame), ox, oy,
                   crop: [470, 340], parts: frontParts });
      continue;
    }

    if (pv.name === 'PLAN' && bearing) {
      const carried = m.members.find((mm) => mm !== bearing && mm.axis && mm.section);
      if (!carried) continue;
      const built = buildPlanView(m, bearing, carried, ox, oy, num, pv.frame);
      if (built) { views.push(built.view); extraEntities.push(...built.entities); }
      continue;
    }

    if (pv.name === 'SECTION A-A') {
      if (endPlate && bearing) {
        const sec = buildBearingAxisSection(m, bearing, grid, boltDims, ox, oy, num, pv.frame);
        if (sec) { views.push(sec.view); extraEntities.push(...sec.entities); }
      } else {
        views.push({ name: 'SECTION A-A', num, ...asDef(pv.frame), ox, oy,
                     crop: [470, 470], hlr: true, flipDepth: true, minLen: 3, noTitle: true });
        // title drawn here, not in the P2 block above, because the number is only known now
        if (plate && grid) viewTitle(P2, [ox - 40, -560], num, 'SECTION A-A', '1:10', TITLE_STYLE);
      }
      continue;
    }

    if (pv.name.endsWith('END PLATE')) {
      const memName = pv.name.replace(/ END PLATE$/, '');
      const mem = m.members.find((mm) => mm.name === memName);
      const ep = mem ? memberEndPlate(m, mem) : undefined;
      if (!mem || !ep) continue;
      const built = buildEndPlateSection(m, mem, ep, m.boltGrids[0], boltDims, holeR,
                                        ox, oy, num, pv.frame);
      if (built) { views.push(built.view); extraEntities.push(...built.entities); }
      continue;
    }

    // A view coverage proposed that no builder knows how to draw yet: emit the silhouette-only
    // view rather than dropping it silently, so the gap is visible on the sheet, and let the
    // plan's WARN flag explain why it is there.
    views.push({ name: pv.name, num, ...asDef(pv.frame), ox, oy, crop: [470, 470], minLen: 3 });
  }

  // ---- SECTION MARKS: draw each section's cut line INSIDE its parent view -----------------------
  // This is what makes the view set readable as a tree rather than a pile: without it a reader
  // cannot tell where SECTION A-A was taken. The planner already decided the parent (a view whose
  // plane contains the cut normal); here we only draw it.
  const numOf = new Map<string, string>();
  { let n = 0;
    for (const pv of plan.views) {
      numOf.set(pv.name, pv.role === 'main' ? MAIN_NUM : pv.role === 'iso' ? '' : `${MAIN_NUM}.${++n}`);
    } }
  for (const pv of plan.views) {
    if (pv.role !== 'section' || !pv.parent) continue;
    const parent = plan.views.find((x) => x.name === pv.parent);
    const where = placed.get(pv.parent);
    if (!parent || !where) continue;
    // The arrow points the way the child view LOOKS, so it must use the child's EFFECTIVE viewing
    // normal -- and `flipDepth` inverts that. Reading the raw planner normal instead drew a plan
    // section's arrow pointing up the sheet when a plan looks down.
    const def = views.find((v) => v.name === pv.name);
    const eff = def?.flipDepth ? scale(pv.normal, -1) : pv.normal;
    extraEntities.push(...sectionMarkEntities(
      numOf.get(pv.name) ?? '',
      { frame: { origin: pv.frame.origin }, normal: eff },
      { frame: parent.frame, ox: where.ox, oy: where.oy, crop: where.crop },
    ));
  }

  return {
    meta: { title: `${m.projectName}`, scale: '1:10', units, viewTitle: titleStyle, styleProfile: STYLE_PATH },
    // ground truth for tools/verify_drawing.py (see ExpectSpec) -- read from the MODEL, so the
    // verifier asserts the drawing against the IOM rather than against itself
    expect: {
      archetype: endPlate ? 'end-plate' : 'fin-plate',
      memberNames: m.members.filter((mm) => mm.section).map(memberLabel),
      rootRadii: [...new Set(m.members.map((mm) => mm.section?.params.r2).filter((r): r is number => !!r))],
      plates: m.plates.filter((p) => !p.isNegative).map((p) => ({ name: p.name, t: p.thickness })),
      ...(grid?.assembly ? {
        bolts: {
          count: grid.positions.length,
          d: Math.round(grid.assembly.diameter),
          hole: Math.round(grid.assembly.borehole),
          callout: `${grid.positions.length} x M${Math.round(grid.assembly.diameter)} (${normalizeGrade(grid.assembly.grade)})`,
          // end-plate archetype: the SECTION/END-PLATE views draw the bare-hexagon glyph
          // family (drawBoltGlyphsEndOn/SideOn); fin-plate keeps the older concentric-circle
          // glyph (drawBoltGrid) throughout. FRONT VIEW stays circles-glyph for BOTH archetypes
          // (see drawBoltGrid's docstring) but that isn't separately asserted here in v1.
          glyph: endPlate ? ('hex' as const) : ('circles' as const),
          ...(endPlate ? (() => {
            const t = boltTemplate(grid.assembly!.diameter, boltDims);
            return { s: t.s, e: t.e };
          })() : {}),
          positions: grid.positions.map((p): [number, number, number] => [p.x, p.y, p.z]),
        },
      } : {}),
    },
    layers: LAYERS,
    // the view decision, carried out for auditing/verification (see ViewPlanSpec)
    viewPlan: {
      archetype,
      views: plan.views.map((v) => ({ name: v.name, role: v.role, parent: v.parent,
                                      covers: v.covers, addedByCoverage: v.addedByCoverage })),
      coverage: plan.coverage, uncovered: plan.uncovered, flags: plan.flags,
    },
    ifc: m.source.replace(/(\.iom)?\.xml$/i, '.ifc'),
    views,
    // parametric occluders (I-member flange/web boxes) for the occlusion-clipped bolt glyphs
    // (drawBoltGlyphsEndOn/SideOn) -- the IFC ships every un-cut member as a single box, which
    // can't tell "behind the flange" from "behind the web" apart (see memberOccluders).
    occluders: m.members.flatMap(memberOccluders),
    // P1 draws the FRONT VIEW's annotations. Emit them ONLY when the plan actually asked for
    // that view: the end-plate plan does not (its PLAN + two sections already cover
    // everything), and orphaned annotations would sit on the sheet with no view to belong to
    // -- which is exactly what left 12 bolt glyphs untraceable to any view's projection.
    entities: [...(front ? P1.entities : []), ...P2.entities, ...extraEntities],
    // Generic, neutral title block (NOT a replica of any firm's branding). Objective
    // fields filled; approval/name fields left blank for the engineer.
    sheet: {
      paper: { w: 841, h: 594 }, // A1
      scale: 10,
      title: [
        { label: 'PROJECT', value: '' },
        { label: 'DRAWING TITLE', value: 'STEEL CONNECTION DETAIL' },
        { label: 'CONNECTION', value: m.projectName },
        { label: 'SCALE', value: '1:10' },
        { label: 'DRAWING No', value: '' },
        { label: 'REV', value: '' },
        { label: 'DATE', value: '' },
        { label: 'SHEET', value: '1 OF 1' },
        { label: 'DRAWN', value: '' },
        { label: 'CHECKED', value: '' },
      ],
    },
  };
}
