// WHICH VIEWS does a connection detail need, and WHY?
//
// Hybrid mechanism (chosen 2026-07-27). Two halves that check each other:
//
//   TEMPLATE  -- per archetype, an ordered list of PREFERRED view frames, names and roles. This is
//                how a detailer actually works (a house template per connection type) and it keeps
//                the output stable and conventional.
//   COVERAGE  -- the envelope/guard. Every piece of fabrication information the drawing must carry
//                is enumerated from the model, each with the condition a view must satisfy to be
//                able to carry it. If the template's views leave something uncoverable, an extra
//                view is proposed (WARN) or the gap is reported (REVIEW). Never silently dropped.
//
// This replaces a hardcoded `views.push([...])` list. The point is not the count -- it is that
// something in the code can now answer "why does this view exist" and "what is missing".
//
// Grounding (docs/drawing-conventions.md 8.9/8.10):
//   * Views form a TREE: one MAIN view + N SECTIONs, each section carrying exactly one section
//     mark drawn in another view, so #marks == #sections always.
//   * An ISOMETRIC sits OUTSIDE the tree: no mark, no number, and drawn all-visible.
//   * Section counts vary with the connection (typically 1 to 3). Coverage explains that spread;
//     no count formula is assumed.
//
// FRAMES ARE FEATURE-DERIVED, never global axes. A frame tied to global X/Y/Z is only right when
// the model happens to be axis-aligned, which is why the rotation-invariance test fails today.

import type { ConnectionModel, Member, Plate, BoltGrid, Vec3 } from '../model/types.ts';

// ---- vector helpers (kept local so this module has no drawing dependencies) ----
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return scale(a, 1 / l); };

/** Angle tolerance for "these two directions are the same / perpendicular", in the same spirit as
 * viewplan.py's SKEW_TOL_DEG: steel detailing treats a couple of degrees as square. A view whose
 * normal is 2 degrees off still shows the feature true-length for drafting purposes. */
export const ANGLE_TOL_DEG = 2.0;
const COS_TOL = Math.cos((90 - ANGLE_TOL_DEG) * Math.PI / 180);   // ~0.0349
const PARALLEL_TOL = Math.cos(ANGLE_TOL_DEG * Math.PI / 180);     // ~0.9994

/** |a.b| ~ 1 : same line (either sense). */
export const isParallel = (a: Vec3, b: Vec3): boolean => Math.abs(dot(norm(a), norm(b))) >= PARALLEL_TOL;
/** |a.b| ~ 0 : perpendicular, i.e. `a` LIES IN a plane whose normal is `b`. */
export const isPerp = (a: Vec3, b: Vec3): boolean => Math.abs(dot(norm(a), norm(b))) <= COS_TOL;

export type Severity = 'INFO' | 'WARN' | 'REVIEW';
export interface PlanFlag { code: string; severity: Severity; message: string }

/** One piece of information the drawing must carry, plus the condition a view must meet to be able
 * to carry it. `ok(n)` takes a view NORMAL (the direction the viewer looks along). */
export interface InfoItem {
  id: string;
  what: string;
  ok(n: Vec3): boolean;
}

export interface Frame { origin: Vec3; u: Vec3; v: Vec3 }

export interface PlannedView {
  name: string;
  role: 'main' | 'section' | 'iso';
  frame: Frame;
  normal: Vec3;
  /** which view this one is cut FROM -- its section mark is drawn there (undefined for main/iso) */
  parent?: string;
  /** InfoItem ids this view can carry: the audit trail for "why does this view exist" */
  covers: string[];
  /** true when coverage added this view on top of the template */
  addedByCoverage?: boolean;
}

export interface Plan {
  views: PlannedView[];
  flags: PlanFlag[];
  /** items no selected view can carry -- each also raises a REVIEW flag */
  uncovered: { id: string; what: string }[];
  /** every item with the views that cover it, for the verifier and for auditing */
  coverage: { id: string; what: string; views: string[] }[];
}

// ---------------------------------------------------------------------------
// 1. WHAT MUST THE DRAWING SAY?
// ---------------------------------------------------------------------------

const memberAxis = (m: Member): Vec3 | undefined =>
  m.axis ? norm(sub(m.axis.end, m.axis.start)) : undefined;

/** The point on a member's axis nearest the model origin -- the IOM places the connection origin at
 * the joint, so this is the joint point on that member. */
function nearestOnAxis(m: Member): Vec3 {
  if (!m.axis) return { x: 0, y: 0, z: 0 };
  const d = memberAxis(m)!;
  return add(m.axis.start, scale(d, -dot(m.axis.start, d)));
}

/** The information a fabricator must be able to read off this connection, each tagged with the
 * view condition that makes it readable. Only items whose readability DEPENDS on the view are
 * listed -- a part's profile designation is a label and can go anywhere, so it drives nothing. */
export function requiredInfo(m: ConnectionModel): InfoItem[] {
  const items: InfoItem[] = [];

  for (const pl of m.plates.filter((p) => !p.isNegative)) {
    const pn = norm(pl.lcs.az);                     // plate thickness direction
    items.push({
      id: `plate:${pl.name}:thickness`,
      what: `plate ${pl.name} thickness (${Math.round(pl.thickness)})`,
      // readable only where the plate is EDGE-ON: its thickness direction lies in the view plane
      ok: (n) => isPerp(pn, n),
    });
    items.push({
      id: `plate:${pl.name}:outline`,
      what: `plate ${pl.name} outline / height+width`,
      // readable only where the plate is FACE-ON: you are looking along its thickness
      ok: (n) => isParallel(pn, n),
    });
  }

  for (const [i, g] of m.boltGrids.entries()) {
    const ga = norm(g.lcs.az);                      // bolt axis
    items.push({
      id: `bolts:${i}:pattern`,
      what: `bolt gauge / pitch / edge distances (${g.positions.length} bolts)`,
      // the in-plane pattern is only true-shape looking ALONG the bolt axis
      ok: (n) => isParallel(ga, n),
    });
    items.push({
      id: `bolts:${i}:grip`,
      what: 'bolt grip / which side the plate sits',
      // the stack along the bolt axis is only measurable with that axis in the view plane
      ok: (n) => isPerp(ga, n),
    });
  }

  for (const mem of m.members) {
    const ax = memberAxis(mem);
    if (!ax || !mem.section) continue;
    items.push({
      id: `member:${mem.name}:depth`,
      what: `member ${mem.name} depth / how it frames in`,
      // a member's depth and its setback read in ELEVATION -- its axis in the view plane
      ok: (n) => isPerp(ax, n),
    });
  }

  for (const [i, w] of m.welds.entries()) {
    const d = sub(w.end, w.start);
    if (len(d) < 1e-6) continue;                    // a point weld reads anywhere
    const wd = norm(d);
    items.push({
      id: `weld:${i}:size`,
      what: `weld ${w.name || i} size / type`,
      // the weld's length and throat read where the weld line lies in the view plane
      ok: (n) => isPerp(wd, n),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// 2. WHICH FRAMES ARE AVAILABLE? (all feature-derived)
// ---------------------------------------------------------------------------

/** Build a right-handed frame that LOOKS ALONG `n` (so cross(u,v) == n), choosing the in-plane
 * "up" from a preference list so the result is reproducible and reads conventionally rather than
 * arbitrarily rotated. `prefUp` candidates are tried in order; the first one not parallel to `n`
 * wins, projected into the view plane. */
export function frameLookingAlong(n: Vec3, origin: Vec3, prefUp: Vec3[],
                                  prefRight?: Vec3): Frame {
  let N = norm(n);
  let up: Vec3 | undefined;
  for (const c of prefUp) {
    if (len(c) < 1e-9 || isParallel(c, N)) continue;
    const proj = sub(c, scale(N, dot(c, N)));       // component of c in the view plane
    if (len(proj) > 1e-6) { up = norm(proj); break; }
  }
  if (!up) {
    // every preference was parallel to the normal -- fall back to any perpendicular direction
    const seed: Vec3 = Math.abs(N.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    up = norm(sub(seed, scale(N, dot(seed, N))));
  }
  // cross(u, v) must equal N (the convention view_linework/Painter use), so u = v x N
  let u = norm(cross(up, N));
  // WHICH WAY IS RIGHT. A feature direction only fixes the view's LINE of sight, not its sense --
  // looking along +axis or -axis mirrors the drawing left-for-right. Rather than pick a global
  // axis (which would destroy rotation-invariance) the caller names a feature that should read
  // rightwards, e.g. "the carried beam frames in from the right" as the house style draws it.
  // Flipping N and u together keeps cross(u, v) == N.
  if (prefRight && len(prefRight) > 1e-9 && dot(prefRight, u) < 0) {
    N = scale(N, -1);
    u = scale(u, -1);
  }
  return { origin, u, v: up };
}

export interface CandidateDir { dir: Vec3; why: string }

/** Every direction the MODEL itself offers as a view normal: member axes, member flange normals
 * ("looking at the flange face"), plate normals and bolt-grid axes. Deduped by direction, so two
 * features that happen to share an axis yield one candidate carrying both reasons. */
export function candidateDirections(m: ConnectionModel): CandidateDir[] {
  const out: CandidateDir[] = [];
  const push = (d: Vec3 | undefined, why: string) => {
    if (!d || len(d) < 1e-9) return;
    const n = norm(d);
    const hit = out.find((c) => isParallel(c.dir, n));
    if (hit) { if (!hit.why.includes(why)) hit.why += ` / ${why}`; return; }
    out.push({ dir: n, why });
  };
  for (const mem of m.members) {
    push(memberAxis(mem), `along ${mem.name} axis`);
    if (mem.sectionFrame) push(mem.sectionFrame.vz, `onto ${mem.name} flange face`);
  }
  for (const pl of m.plates.filter((p) => !p.isNegative)) push(pl.lcs.az, `onto plate ${pl.name}`);
  for (const [i, g] of m.boltGrids.entries()) push(g.lcs.az, `along bolt axis ${i}`);
  return out;
}

// ---------------------------------------------------------------------------
// 3. THE ARCHETYPE TEMPLATE (preferred frames, in order)
// ---------------------------------------------------------------------------

export type Archetype = 'fin-plate' | 'end-plate';

interface TemplateEntry {
  name: string;
  role: 'main' | 'section' | 'iso';
  /** the model direction this view looks along; undefined => skip this entry */
  dir?: Vec3;
  /** which model direction should read UPWARDS on the sheet (projected into the view plane) */
  up?: Vec3;
  /** which model direction should read RIGHTWARDS -- fixes the mirror sense (see frameLookingAlong) */
  right?: Vec3;
  why: string;
}

/** The house template. Each entry names a view and the FEATURE it looks along -- the house
 * style's usual views, but expressed as model features instead of global axes:
 *
 *   fin plate: FRONT VIEW looks along the BOLT AXIS, which is also the
 *     supporting member's axis, so the support reads as a true cross-section, the carried beam in
 *     elevation, the plate face-on and the bolt pattern true-shape. SECTION A-A looks onto the
 *     members' FLANGE FACE (a plan for horizontal members): both members show their flange width
 *     with the webs dashed beneath, and the plate goes edge-on so its thickness is measurable.
 *
 *   end plate: PLAN onto the bearing member's flange face is the parent view;
 *     SECTION A-A looks along the bearing axis; one END PLATE section per member looks along that
 *     member's own axis.
 */
export function template(m: ConnectionModel, archetype: Archetype,
                        bearing?: Member): TemplateEntry[] {
  const grid = m.boltGrids[0];
  const out: TemplateEntry[] = [];
  const support = bearing ?? m.members.find((mm) => mm.section);
  const carried = m.members.find((mm) => mm !== support && mm.axis && mm.section);
  const supFlange = support?.sectionFrame ? norm(support.sectionFrame.vz) : undefined;
  const supAx = support ? memberAxis(support) : undefined;

  // WHICH WAY THE CARRIED MEMBER POINTS, from the joint outwards. A member's stored axis sense is
  // arbitrary (start->end as the exporter happened to write it), so "the beam is on the right"
  // cannot be expressed with the raw axis -- it needs the direction from the JOINT to the member's
  // far end, which is a real feature.
  const joint = support?.axis ? nearestOnAxis(support) : { x: 0, y: 0, z: 0 };
  const carriedOut = ((): Vec3 | undefined => {
    if (!carried?.axis) return undefined;
    const ax = memberAxis(carried);
    if (!ax) return undefined;
    const ds = len(sub(carried.axis.start, joint)), de = len(sub(carried.axis.end, joint));
    const far = de >= ds ? carried.axis.end : carried.axis.start;
    // Take only the SENSE from the joint, and keep the DIRECTION exactly along the member's own
    // axis. Using the raw (far - joint) vector instead is subtly wrong: the two member axes need
    // not intersect exactly, so that difference comes out a few degrees off the axis -- measured
    // 7 degrees here, which was enough for the 2-degree parallel test to declare the end-plate
    // view NOT face-on to its own plate, lose the outline + bolt-pattern coverage, and make the
    // guard add a redundant fourth section.
    return dot(sub(far, joint), ax) >= 0 ? ax : scale(ax, -1);
  })();
  // MIRROR SENSE IS A HOUSE CONVENTION, NOT GEOMETRY. Looking along +axis or -axis gives the same
  // information mirrored, so the model cannot decide it; the house style does, and it may decide
  // DIFFERENTLY per archetype: the fin-plate FRONT VIEW puts the carried beam on the RIGHT (support
  // at the left), while the end-plate SECTION 01.1 puts the carried beam on the LEFT (bearing member
  // at the right). Both are written into the template below rather than guessed. It is not purely cosmetic either: the
  // two senses look from opposite sides, so the sense decides whether the bolt assemblies sit in
  // front of the plate pack or behind it -- get it wrong and occlusion legitimately deletes them.
  const carriedLeft = carriedOut ? scale(carriedOut, -1) : undefined;

  if (archetype === 'fin-plate') {
    // the bolt axis is normal to the plate and, for a square connection, parallel to the support's
    // axis -- so one frame gives the plate face-on AND the support as a true cross-section
    const boltAxis = grid ? norm(grid.lcs.az) : undefined;
    out.push({ name: 'FRONT VIEW', role: 'main', dir: boltAxis ?? supAx,
               up: supFlange, right: carriedOut,
               why: 'bolt pattern true-shape + plate face-on' });
    out.push({ name: 'SECTION A-A', role: 'section', dir: supFlange,
               up: supAx, right: carriedOut,
               why: 'plate edge-on (thickness + which side) + webs under flanges' });
  } else {
    out.push({ name: 'PLAN', role: 'main', dir: supFlange,
               up: supAx, right: carriedOut,
               why: 'both members and the plate pack seen from above' });
    out.push({ name: 'SECTION A-A', role: 'section', dir: supAx,
               up: supFlange, right: carriedLeft,
               why: 'bearing member cross-section + plate stack edge-on' });
    if (carried) {
      // Look from OUTSIDE the member back towards the joint: that is what puts its end plate
      // face-on with the bolt heads towards the viewer. Looking the other way (outward from the
      // joint) shows the same plate mirrored but with the whole bolt group behind it, so occlusion
      // correctly deletes every glyph -- the sense is load-bearing here, not cosmetic.
      out.push({ name: `${carried.name} END PLATE`, role: 'section',
                 dir: carriedOut ? scale(carriedOut, -1) : undefined,
                 up: carried.sectionFrame ? norm(carried.sectionFrame.vz) : supFlange,
                 right: carried.sectionFrame ? norm(carried.sectionFrame.vy) : undefined,
                 why: 'end plate face-on: hole pattern and outline' });
    }
  }
  out.push({ name: 'ISOMETRIC', role: 'iso', dir: undefined, why: 'orientation aid (not measured)' });
  return out;
}

// ---------------------------------------------------------------------------
// 4. PLAN = TEMPLATE + COVERAGE GUARD
// ---------------------------------------------------------------------------

/** Maximum extra views coverage may add on top of the template before giving up and reporting the
 * gap instead. A detail that needs 3 more views than its template is not a template mismatch, it
 * is a connection the template does not describe -- that deserves a human, not more views. */
export const MAX_ADDED_VIEWS = 2;

/** The isometric's own frame: the standard isometric basis, but built from the model's own vertical
 * so it rotates WITH the connection instead of being pinned to global axes. */
function isoFrame(origin: Vec3, up: Vec3): Frame {
  // a 1:1:1 oblique direction expressed in a frame whose "up" is the model's own
  const seed: Vec3 = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = norm(cross(up, seed));
  const e2 = norm(cross(up, e1));
  const n = norm(add(add(scale(e1, 1), scale(e2, 1)), scale(up, 1)));
  return frameLookingAlong(n, origin, [up]);
}

export function planViews(
  m: ConnectionModel, archetype: Archetype, bearing: Member | undefined, origin: Vec3,
): Plan {
  const items = requiredInfo(m);
  const flags: PlanFlag[] = [];
  const views: PlannedView[] = [];

  const up: Vec3 = bearing?.sectionFrame ? norm(bearing.sectionFrame.vz) : { x: 0, y: 0, z: 1 };
  const prefUp = [up, { x: 0, y: 0, z: 1 } as Vec3];

  // --- 4a. the template's views ---
  for (const t of template(m, archetype, bearing)) {
    if (t.role === 'iso') {
      const f = isoFrame(origin, up);
      views.push({ name: t.name, role: 'iso', frame: f, normal: norm(cross(f.u, f.v)), covers: [] });
      continue;
    }
    if (!t.dir) {
      flags.push({ code: 'TEMPLATE_DIR_MISSING', severity: 'WARN',
                   message: `${t.name} skipped: the model does not provide the feature it looks `
                          + `along (${t.why}). The connection may be missing a member, plate or `
                          + `bolt grid the template assumes.` });
      continue;
    }
    const ups = [t.up, ...prefUp].filter((x): x is Vec3 => !!x);
    const frame = frameLookingAlong(t.dir, origin, ups, t.right);
    // the frame may have flipped the line of sight to satisfy `right`, so take the normal FROM it
    views.push({ name: t.name, role: t.role, frame,
                 normal: norm(cross(frame.u, frame.v)), covers: [] });
  }

  // --- 4b. coverage: which items can the selected views carry? ---
  const coveredBy = (n: Vec3) => items.filter((it) => it.ok(n)).map((it) => it.id);
  for (const v of views) {
    if (v.role === 'iso') continue;    // an isometric is not a measured view; it carries nothing
    v.covers = coveredBy(v.normal);
  }
  const isCovered = (id: string) => views.some((v) => v.covers.includes(id));

  // --- 4c. the GUARD: propose extra views for anything uncovered ---
  let added = 0;
  for (;;) {
    const missing = items.filter((it) => !isCovered(it.id));
    if (!missing.length || added >= MAX_ADDED_VIEWS) break;
    // among the model's own candidate directions, which unused one covers the most gaps?
    const cands = candidateDirections(m)
      .filter((c) => !views.some((v) => v.role !== 'iso' && isParallel(v.normal, c.dir)))
      .map((c) => ({ c, gain: missing.filter((it) => it.ok(c.dir)).map((it) => it.id) }))
      .filter((x) => x.gain.length > 0)
      .sort((a, b) => b.gain.length - a.gain.length);
    if (!cands.length) break;
    const best = cands[0]!;
    const frame = frameLookingAlong(best.c.dir, origin, prefUp);
    views.push({ name: `SECTION ${String.fromCharCode(66 + added)}-${String.fromCharCode(66 + added)}`,
                 role: 'section', frame, normal: best.c.dir,
                 covers: coveredBy(best.c.dir), addedByCoverage: true });
    flags.push({ code: 'VIEW_ADDED', severity: 'WARN',
                 message: `Added a section looking ${best.c.why}: the template's views cannot carry `
                        + best.gain.map((id) => items.find((i) => i.id === id)!.what).join(', ')
                        + '. Check its placement -- it is not part of the house template.' });
    added++;
  }

  // --- 4d. anything still uncovered is reported, never dropped ---
  const uncovered = items.filter((it) => !isCovered(it.id)).map((it) => ({ id: it.id, what: it.what }));
  if (uncovered.length) {
    flags.push({ code: 'INFO_UNCOVERED', severity: 'REVIEW',
                 message: `No view in this drawing can carry: `
                        + uncovered.map((u) => u.what).join('; ')
                        + `. Manual review required -- silently omitting a fabrication dimension is `
                        + `the most dangerous outcome, so this is reported rather than ignored.` });
  }

  // --- 4e. the TREE: every section gets a parent whose view plane contains its cut line ---
  const main = views.find((v) => v.role === 'main');
  for (const v of views) {
    if (v.role !== 'section') continue;
    // the cut line of `v` is visible in a view whose plane CONTAINS v's normal
    const parent = views.find((p) => p !== v && p.role !== 'iso' && isPerp(v.normal, p.normal));
    v.parent = (parent ?? main)?.name;
    if (!parent && main) {
      flags.push({ code: 'MARK_PARENT_APPROX', severity: 'INFO',
                   message: `${v.name}'s cut line is not exactly in the plane of any other view; `
                          + `its section mark is attributed to ${main.name}.` });
    }
  }

  const coverage = items.map((it) => ({
    id: it.id, what: it.what,
    views: views.filter((v) => v.covers.includes(it.id)).map((v) => v.name),
  }));

  const nSec = views.filter((v) => v.role === 'section').length;
  flags.push({ code: 'PLAN', severity: 'INFO',
               message: `${archetype}: 1 main + ${nSec} section(s)`
                      + `${views.some((v) => v.role === 'iso') ? ' + isometric' : ''}; `
                      + `${items.length - uncovered.length}/${items.length} information items covered.` });

  return { views, flags, uncovered, coverage };
}
