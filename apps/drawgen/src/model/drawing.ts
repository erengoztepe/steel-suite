// DrawingSpec: the stack-agnostic 2D drawing recipe produced by the TS side and
// rendered to DXF by the Python (ezdxf) sidecar. All coordinates are in mm.

export type Pt = [number, number];

export interface LayerSpec {
  name: string;
  color: number;        // AutoCAD ACI color index (house style: 7 = ByBlock white/black)
  lineweight?: number;  // 1/100 mm (e.g. 35 = 0.35mm). House differentiates by weight, not colour.
  linetype?: string;    // e.g. "CONTINUOUS", "HIDDEN", "CENTER"
}

export type Entity =
  | { type: 'polyline'; layer: string; closed: boolean; points: Pt[] }
  | { type: 'circle'; layer: string; center: Pt; r: number }
  // Arc, CCW from start to end (degrees). Used for rolled-profile root fillets.
  | { type: 'arc'; layer: string; center: Pt; r: number; start: number; end: number }
  | { type: 'line'; layer: string; start: Pt; end: Pt }
  // `avoid` => the Python renderer nudges `pos` outward (after ALL geometry is drawn, incl.
  // IFC silhouettes it can't see on the TS side) to the nearest slot clear of drawn lines,
  // then draws a leader from the placed text back to `leader` (or the original pos).
  | { type: 'text'; layer: string; pos: Pt; height: number; text: string;
      align?: 'left' | 'center' | 'right'; style?: string; avoid?: boolean; leader?: Pt;
      // degrees CCW. Used by section-mark ids, which rotate to align with their own cut line (an
      // id on a vertical section line sits at rot=90) -- the usual drafting rule: rotate the
      // lettering so that it can be read with the sheet straight.
      rotation?: number }
  // Member / plate LABEL in the house grammar: the text is UNDERLINED by a horizontal
  // landing running from 6mm before it to 6mm past it, and (when `anchor` is given) a leader
  // kinks from whichever end of that underline is nearest the anchor, ending in a SOLID
  // arrowhead (profile leader_arrow.label). Drawn entirely by the Python side: the underline length needs real font metrics
  // (see text_width in server/render.py), and placement has to dodge geometry the TS side never
  // sees. Always deferred, so it also dodges other labels. See docs 8.6.
  // `underline` picks which underline geometry to use:
  //   'label' -- member/plate labels: runs from 6mm BEFORE the text to 6mm PAST it (length w+12).
  //   'title' -- view titles in the underlined-title house style: length is exactly the text
  //              width, shifted (-0.6h, -0.35h) from the insert. Different topology
  //              from 'label', not just different numbers -- hence a variant rather than a pad.
  | { type: 'label'; layer: string; pos: Pt; height: number; text: string; anchor?: Pt;
      align?: 'left' | 'center' | 'right'; style?: string; underline?: 'label' | 'title' }
  // Linear dimension. angle 0 = horizontal (measures Δx), 90 = vertical (measures Δy).
  // base = a point the dimension line passes through (sets its offset). Text auto-measured.
  | { type: 'dim'; layer: string; p1: Pt; p2: Pt; base: Pt; angle: number }
  // Filled region. `solid` floods the boundary (leader arrowheads, section-mark arrows);
  // otherwise `pattern` is a line pattern. CUT STEEL *IS* PATTERN-HATCHED: the poché pattern and
  // scale come from profile hatch (e.g. ANSI31 at scale 5 = 15.87mm perpendicular spacing), on the
  // `hatch` role. An earlier round concluded the opposite because it only looked for HATCH
  // *entities*, all of which live in the sheet template's material legend -- inside an issued
  // detail the poché arrives as exploded LINEs. See docs 8.4. Weld-symbol fillet triangles are OUTLINES, never solid (docs 8.7).
  | { type: 'hatch'; layer: string; boundary: Pt[]; solid?: boolean;
      pattern?: string; scale?: number; angle?: number }
  // A 3D polyline, projected and OCCLUSION-CLIPPED by the Python side (server/ifc_geom.py's
  // RayOccluder) using the named view's own frame -- used for glyphs (bolts) whose visible
  // portion depends on what steel actually sits between them and the viewer, which only the
  // Python side can answer (it holds the IFC meshes). `clip: 'none'` still projects through
  // the view but skips occlusion (e.g. when the caller already knows it is unoccluded).
  | { type: 'poly3d'; layer: string; view: string; points: [number, number, number][];
      closed?: boolean; clip?: 'segment' | 'whole' | 'none'; group?: string };

/** A parametric box used ONLY to decide occlusion (never drawn). Stands in for an I-section
 * member's flange/web slabs, which the IFC ships as a single un-cut 24-vertex box unsuited to
 * telling "is there flange material here" from "is there web material here" -- see box_mesh
 * in server/ifc_geom.py. Overlapping boxes are harmless (the occlusion test only asks whether
 * ANY triangle sits between a point and the viewer). All vectors/lengths in mm, global frame. */
export interface OccluderBox {
  name?: string;
  center: [number, number, number];
  ax: [number, number, number];   // unit local axes (need not be global X/Y/Z)
  ay: [number, number, number];
  az: [number, number, number];
  half: [number, number, number]; // half-extents along ax, ay, az respectively
}

/** Paperspace sheet: A-size paper, a viewport at 1:scale, and a (generic) title block. */
export interface SheetSpec {
  paper: { w: number; h: number };   // paper size mm (A1 = 841 x 594)
  scale: number;                     // 1:scale (e.g. 10)
  title: { label: string; value: string }[];  // title-block fields (values may be blank)
}

/** A projected view: frame (origin + basis u,v) + sheet offset. Part OUTLINES are
 * drawn by the Python side from the IFC solids using this exact frame; annotations
 * (in `entities`) are pre-projected by the TS side with the same frame+offset. */
export interface ViewDef {
  name: string;
  num?: string;             // detail-callout number shown in the view-title bubble (e.g. "01", "02")
  origin: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  ox: number;
  oy: number;
  crop?: [number, number];  // half-width/height (mm) around the joint; stubs long members
  // Hidden-line removal, as TWO independent switches (see view_linework in server/ifc_geom.py).
  // interPartHlr: is an edge behind ANOTHER part? Ranks by mean depth, so it misclassifies parts
  //   whose near faces are flush (a plan's two top flanges at one z) -- a plan sets this false.
  // selfHlr: is an edge behind THIS part's own near face? That is what dashes a web under its own
  //   flange -- a plan wants this true.
  // They were one `hlr` flag; a plan turning it off to fix the first lost the second with it, and
  // the web then came out solid under a hand-drawn dashed copy (docs 8.12/D4-D5).
  interPartHlr?: boolean;
  selfHlr?: boolean;
  hlr?: boolean;            // legacy: drives BOTH of the above (default true)
  flipDepth?: boolean;      // view from the opposite side (plan looks DOWN => top flange near)
  minLen?: number;          // shortest feature edge kept (mm); low => show cut notches / holes
  noTitle?: boolean;        // skip the Python-side view title (TS draws it instead)
  // Override the sheet's title policy for THIS view. The isometric is captioned with an
  // underlined title and no number under BOTH title policies (one TEXT + one LINE on the
  // `text` role and no bubble circle at all), even though 'bubble' bubbles every measured view.
  titleStyle?: 'bubble' | 'underline';
  parts?: string[];         // restrict the IFC silhouette pass to these part Names (omit = all parts)
  // Occlusion (for `poly3d` entities targeting this view -- e.g. bolt glyphs): which IFC part
  // NAMES act as occluders (default: every part in `parts`/all parts) and which to exclude
  // (e.g. a member being viewed end-on IS the section cut, not an occluder of its own bolts).
  clipParts?: string[];
  clipIgnore?: string[];
}

/** Model GROUND TRUTH the produced DXF is asserted against by tools/verify_drawing.py.
 * This is deliberately not drawing data: it is what the IOM says must end up in the drawing,
 * so the verifier can check the output without re-parsing the model (and so the checks are
 * not circular -- comparing the drawing to itself would prove nothing). */
export interface ExpectSpec {
  archetype: 'fin-plate' | 'end-plate';
  memberNames: string[];
  rootRadii: number[];                       // section r2 per member; profile fillet arcs must match
  plates: { name: string; t: number }[];
  bolts?: {
    count: number; d: number; hole: number; callout: string;
    // Drawn glyph FAMILY -- the convention differs by house style ('hex': bare hexagon only,
    // no washer/hole/shank circles; 'circles': hole arcs + centre cross). Lets
    // the verifier check the family that was actually asked for instead of hardcoding one.
    glyph?: 'hex' | 'circles';
    s?: number;   // across-flats, when glyph === 'hex' (from the bolt geometry DB)
    e?: number;   // across-corners, when glyph === 'hex'
    // model bolt positions (global mm) -- lets the verifier confirm every drawn glyph traces
    // to a real bolt (a SUBSET check: an occluded bolt may legally be omitted from a view,
    // but a glyph may never be invented or mis-placed).
    positions?: [number, number, number][];
  };
}

/** The view plan's own output, carried into the spec so the decision is AUDITABLE: which views were
 * chosen, why each exists (what information it carries), what nothing can carry, and what the guard
 * had to say. See app/src/drawing/viewplan.ts. tools/verify_drawing.py asserts against it. */
export interface ViewPlanSpec {
  archetype: 'fin-plate' | 'end-plate';
  views: { name: string; role: 'main' | 'section' | 'iso'; parent?: string; covers: string[];
           addedByCoverage?: boolean }[];
  coverage: { id: string; what: string; views: string[] }[];
  uncovered: { id: string; what: string }[];
  flags: { code: string; severity: 'INFO' | 'WARN' | 'REVIEW'; message: string }[];
}

export interface DrawingSpec {
  // `units` is the DOCUMENT's unit base, chosen by the user. Every coordinate and size in this
  // spec is always CANONICAL MILLIMETRES (so each constant can be read straight against the
  // measurements in docs/drawing-conventions.md); server/render.py applies the
  // base as a single scale factor in one place. The linetype table is never scaled: the unit
  // sets the physical dash size -- a mm-native drawing prints the table's dash as-is, a
  // cm-native one 10x on paper. See docs 8.2.
  // `viewTitle` is the HOUSE POLICY for how a view announces itself. Both policies draw the
  // SAME bubble glyph (profile view_title.bubble_r; number + name + scale, name at +105/+14) but
  // attach it to different things:
  //   'bubble'    -- EVERY view carries its own bubble, and the numbering is hierarchical
  //                  (01 = main, 01.1 / 01.2 = its sections).
  //   'underline' -- individual views get an UNDERLINED plain-text title (no bubble, no
  //                  number, no scale), and one bubble titles the SHEET instead (01 + the drawing
  //                  name + 1:10).
  // Whichever is active must apply to EVERY view: our fin-plate SECTION A-A used to draw a bare
  // caption while its siblings got bubbles, which is neither policy.
  meta: { title: string; scale: string; units: 'mm' | 'cm'; viewTitle?: 'bubble' | 'underline';
          /** style profile the spec was built against (see model/style.ts) */ styleProfile?: string };
  expect?: ExpectSpec;
  layers: LayerSpec[];
  entities: Entity[];   // model-space annotations (real mm), pre-projected
  sheet?: SheetSpec;
  ifc?: string;         // absolute path to the IFC (coped solids) for part outlines
  ifcTransform?: number[]; // optional 3x3 rotation (row-major, len 9) applied to IFC verts (rot-invariance test)
  views?: ViewDef[];    // frames the Python side projects the IFC parts into
  viewPlan?: ViewPlanSpec;   // why those views: the plan + its coverage guard
  occluders?: OccluderBox[]; // parametric occluders (e.g. I-member flange/web boxes) shared by every view
}
