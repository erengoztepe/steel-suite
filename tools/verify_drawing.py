"""Machine-checkable audit of a produced connection detail DXF.

WHY THIS EXISTS: the dominant failure mode of this pipeline is "plausible but wrong" -- it
always emits a drawing, so a wrong drawing looks like a working one. Eyeballing a rendered
PNG is blind to exactly that (it cost us two misdiagnoses: the SECTION A-A cut direction and
the ghost flange centreline). So correctness is asserted numerically here, against the MODEL
ground truth that the TS side publishes in spec.json's `expect` block -- never against the
drawing itself, which would prove nothing.

Usage:
    python tools/verify_drawing.py <drawing.dxf> <spec.json> [--golden <snapshot.json>]

Exit code 0 = all checks pass (warnings allowed), 1 = at least one FAIL.
"""
from __future__ import annotations
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import ezdxf
from ezdxf import bbox

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import house_style as hs  # noqa: E402

# The verifier works in ROLES, like the renderer: main() maps every entity's real layer name
# back to its role through the active style profile before any check runs, so the checks hold
# for whichever house style the drawing was rendered in.
# role -> required entity-level linetype (dashing lives on the ENTITY, the layer stays
# Continuous); filled from the profile in main().
ROLE_LINETYPE: dict = {}
GEOMETRY_LAYERS = {"visible", "visible_thin", "cut", "hidden", "bolt"}
# a detail is a clean 2D abstraction: these types mean raw mesh/tessellation leaked through
FORBIDDEN_TYPES = {"SPLINE", "ELLIPSE", "MESH", "3DFACE", "POLYFACE", "BODY", "SURFACE"}
TOL = 0.6  # mm


class Report:
    def __init__(self) -> None:
        self.fails: list[str] = []
        self.warns: list[str] = []
        self.notes: list[str] = []

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        (self.notes if ok else self.fails).append(f"{label}{(': ' + detail) if detail else ''}")
        return ok

    def warn(self, label: str, detail: str = "") -> None:
        self.warns.append(f"{label}{(': ' + detail) if detail else ''}")

    def note(self, label: str) -> None:
        self.notes.append(label)

    def emit(self) -> int:
        for n in self.notes:
            print(f"  ok   {n}")
        for w in self.warns:
            print(f"  WARN {w}")
        for f in self.fails:
            print(f"  FAIL {f}")
        print(f"\n{len(self.notes)} passed, {len(self.warns)} warnings, {len(self.fails)} failures")
        return 1 if self.fails else 0


def texts(msp):
    """(text, layer, insert) for every TEXT/MTEXT."""
    out = []
    for e in msp:
        if e.dxftype() == "TEXT":
            out.append((e.dxf.text.strip(), e.dxf.layer, e.dxf.insert))
        elif e.dxftype() == "MTEXT":
            out.append((e.text.strip(), e.dxf.layer, e.dxf.insert))
    return out


def cluster_bolts(msp, tol=1.0):
    """Group bolt-role circles by centre -> {centre: [radii]}. A bolt glyph is a stack of
    concentric circles (shank / hole / washer), so one cluster == one drawn bolt.
    (The 'circles' glyph family -- see hex_polys for the hexagon-only family.)"""
    clusters: dict[tuple[float, float], list[float]] = defaultdict(list)
    for e in msp.query("CIRCLE"):
        if e.dxf.layer != "bolt":
            continue
        c = e.dxf.center
        key = None
        for k in clusters:
            if math.hypot(k[0] - c.x, k[1] - c.y) < tol:
                key = k
                break
        clusters[key or (round(c.x, 2), round(c.y, 2))].append(round(e.dxf.radius, 2))
    return clusters


def hex_polys(msp):
    """Every closed 6-vertex LWPOLYLINE on bolt-role: (centre, across_flats, across_corners).
    This is the END-ON bolt glyph of the bare-hexagon family (end-plate house style) -- a plain
    regular hexagon, no washer/hole/shank circle, no cross-hairs: six-line polygons only."""
    out = []
    for e in msp.query("LWPOLYLINE"):
        if e.dxf.layer != "bolt" or not e.closed:
            continue
        pts = [(p[0], p[1]) for p in e.get_points()]
        if len(pts) != 6:
            continue
        cx = sum(p[0] for p in pts) / 6
        cy = sum(p[1] for p in pts) / 6
        corners = 2 * max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)
        mids = [((pts[i][0] + pts[(i + 1) % 6][0]) / 2, (pts[i][1] + pts[(i + 1) % 6][1]) / 2)
                for i in range(6)]
        flats = 2 * max(math.hypot(m[0] - cx, m[1] - cy) for m in mids)
        out.append(((round(cx, 2), round(cy, 2)), round(flats, 2), round(corners, 2)))
    return out


def bolt_glyph_centres(msp) -> list[tuple[float, float]]:
    """Centroid of every drawn bolt-role glyph element, family-agnostic (CIRCLE / closed
    LWPOLYLINE / LINE) -- used by the provenance and omission-style checks, which must work
    whichever glyph convention the drawing declares."""
    out = []
    for e in msp.query("CIRCLE"):
        if e.dxf.layer == "bolt":
            c = e.dxf.center
            out.append((c.x, c.y))
    for e in msp.query("LWPOLYLINE"):
        if e.dxf.layer == "bolt":
            pts = [(p[0], p[1]) for p in e.get_points()]
            if pts:
                out.append((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))
    for e in msp.query("LINE"):
        if e.dxf.layer == "bolt":
            s, en = e.dxf.start, e.dxf.end
            out.append(((s.x + en.x) / 2, (s.y + en.y) / 2))
    return out


def check_primitive_purity(msp, rep: Report) -> None:
    found = Counter(e.dxftype() for e in msp if e.dxftype() in FORBIDDEN_TYPES)
    rep.check(not found, "primitive purity (no mesh/spline leakage)", str(dict(found)))


def check_line_grammar(msp, rep: Report) -> None:
    """Role must be encoded twice: by layer AND by entity linetype; colour must stay BYLAYER
    so meaning never rides on colour (monochrome-safe)."""
    bad_lt, bad_color = [], []
    for e in msp:
        lay = e.dxf.layer
        if lay not in GEOMETRY_LAYERS:
            continue
        want = ROLE_LINETYPE.get(lay)
        if want:
            lt = getattr(e.dxf, "linetype", "BYLAYER")
            if lt != want:
                bad_lt.append(f"{e.dxftype()} on {lay} has linetype {lt!r} (want {want!r})")
        if getattr(e.dxf, "color", 256) != 256:
            bad_color.append(f"{e.dxftype()} on {lay} colour={e.dxf.color}")
    rep.check(not bad_lt, "role->linetype mapping", "; ".join(bad_lt[:4]))
    rep.check(not bad_color, "colour is BYLAYER everywhere", "; ".join(bad_color[:4]))


UNIT_SCALES = {"mm": 1.0, "cm": 0.1}


def unit_scale(spec: dict) -> float:
    """Drawing units per millimetre for this spec's unit base (see DrawingSpec.meta.units).

    The `expect` block is model GROUND TRUTH and is always in millimetres, as is every house-style
    figure in docs/drawing-conventions.md. A cm-native drawing therefore measures 10x
    smaller than its own expectations, and without this every length check fails by exactly 10 --
    which is a units mismatch, not a defect. Measurements are divided by this factor before any
    comparison, so both the thresholds and the failure messages stay in millimetres.
    """
    name = str((spec.get("meta") or {}).get("units", "mm")).lower()
    if name not in UNIT_SCALES:
        raise ValueError(f"unknown unit base {name!r}; expected one of {sorted(UNIT_SCALES)}")
    return UNIT_SCALES[name]


def check_bolts(msp, expect: dict, rep: Report, S: float = 1.0) -> None:
    """Dispatches to the glyph family the spec actually declared (expect.bolts.glyph), so this
    stays correct whichever house convention is in force -- concentric circles (hole arcs +
    centre cross) or a bare hexagon -- without hardcoding either."""
    b = expect.get("bolts")
    if not b:
        rep.warn("bolt checks skipped (no bolt data in expect)")
        return
    if b.get("glyph") == "hex":
        _check_bolts_hex(msp, b, rep, S)
    else:
        _check_bolts_circles(msp, b, rep, S)


def _check_bolts_circles(msp, b: dict, rep: Report, S: float = 1.0) -> None:
    clusters = cluster_bolts(msp)
    if not clusters:
        rep.check(False, "bolt glyphs present", "no bolt-role circles found")
        return
    # every glyph must carry the nominal shank and the clearance hole, straight from the model
    want_shank, want_hole = b["d"] / 2.0, b["hole"] / 2.0
    missing = []
    for c, radii in clusters.items():
        radii = [r / S for r in radii]        # drawing units -> mm
        if not any(abs(r - want_shank) < TOL for r in radii):
            missing.append(f"{c} lacks shank r={want_shank}")
        elif not any(abs(r - want_hole) < TOL for r in radii):
            missing.append(f"{c} lacks hole r={want_hole}")
    rep.check(not missing, f"bolt glyph radii match model (M{b['d']}, hole {b['hole']})",
              "; ".join(missing[:3]))
    # count must be a whole multiple of the model's bolt count (one full grid per bolted view)
    n = len(clusters)
    ok = n % b["count"] == 0
    rep.check(ok, f"bolt count is a multiple of {b['count']}",
              f"{n} glyph clusters -> {n / b['count']:.2f} grids")
    if ok:
        rep.note(f"bolt grid drawn in {n // b['count']} view(s)")


def _check_bolts_hex(msp, b: dict, rep: Report, S: float = 1.0) -> None:
    hexes = hex_polys(msp)
    if not hexes:
        rep.check(False, "bolt glyphs present (hex)", "no closed hexagon LWPOLYLINE on bolt-role")
        return
    want_s, want_e = b.get("s"), b.get("e")
    bad = []
    for c, af, ac in hexes:
        af, ac = af / S, ac / S           # drawing units -> mm
        if want_s is not None and abs(af - want_s) > TOL:
            bad.append(f"{c} across-flats={af:.2f} (want {want_s})")
        if want_e is not None and abs(ac - want_e) > TOL:
            bad.append(f"{c} across-corners={ac:.2f} (want {want_e})")
    # two INDEPENDENT model-derived numbers (across-flats AND across-corners) must both match --
    # at least as strong a provenance signal as the old shank+hole circle pair.
    rep.check(not bad, f"hex bolt glyphs match model (s={want_s}, e={want_e})", "; ".join(bad[:4]))
    rep.note(f"{len(hexes)} hexagon bolt glyph(s) found (end-on views)")
    # occlusion legitimately varies the count per view, so there is no fixed multiple to assert
    # here (unlike the circles family) -- provenance is asserted separately, in bulk, by
    # check_bolt_provenance.


def _best_shift(candidates, points, bucket=5.0) -> tuple[float, float]:
    """Recover the single (dx, dy) translation that aligns the most candidate/point pairs.
    render.py's `_origin_to_corner` shifts the WHOLE drawing by one fixed vector after every
    view is projected (so the WCS origin parks in empty space, bottom-left) -- that shift isn't
    published anywhere, so this votes for the translation the real geometry agrees on instead
    of requiring render.py to expose it."""
    votes: Counter = Counter()
    for cx, cy in candidates:
        for gx, gy in points:
            votes[(round((gx - cx) / bucket) * bucket, round((gy - cy) / bucket) * bucket)] += 1
    return votes.most_common(1)[0][0] if votes else (0.0, 0.0)


def check_bolt_provenance(msp, spec: dict, rep: Report, S: float = 1.0) -> None:
    """Every drawn bolt-role glyph must trace to a REAL model bolt position, projected through
    SOME view in the spec. This is a SUBSET check, deliberately: an occluded bolt may legally
    be omitted from a view (that is the whole point of occlusion-aware clipping), but a glyph
    may never be invented out of thin air or drawn at the wrong spot."""
    b = (spec.get("expect") or {}).get("bolts") or {}
    positions = b.get("positions")
    views = spec.get("views") or []
    if not positions or not views:
        rep.warn("bolt provenance check skipped (no expect.bolts.positions / views in spec)")
        return
    candidates = []
    for v in views:
        o, u, vv, ox, oy = v["origin"], v["u"], v["v"], v["ox"], v["oy"]
        for p in positions:
            d = [p[i] - o[i] for i in range(3)]
            pu = sum(d[i] * u[i] for i in range(3)) + ox
            pv = sum(d[i] * vv[i] for i in range(3)) + oy
            candidates.append((pu, pv))
    # `candidates` are projected from the spec, which is canonical mm; the drawn centres are in
    # drawing units. Normalise the drawn side so both live in mm (see unit_scale).
    centres = [(x / S, y / S) for x, y in bolt_glyph_centres(msp)]
    dx, dy = _best_shift(candidates, centres)
    shifted = [(px + dx, py + dy) for px, py in candidates]
    # generous tolerance: a glyph element's centroid (e.g. a side-on head/nut/shank LINE) can
    # legitimately sit tens of mm from the bolt axis point along the bolt's own axis (the whole
    # assembly -- washer to nut -- spans ~2-3x the diameter); this check is about PROVENANCE
    # (drawn near a real bolt line, not a hallucinated position), not glyph-element placement.
    axis_tol = max(80.0, 4 * b.get("d", 20))
    unmatched = [c for c in centres
                 if not any(math.hypot(c[0] - px, c[1] - py) < axis_tol for px, py in shifted)]
    rep.check(not unmatched, "every bolt-role glyph traces to a model bolt position",
              f"{len(unmatched)} unmatched centre(s): {[tuple(round(x, 0) for x in c) for c in unmatched[:3]]}")


def check_bolt_omission_style(msp, rep: Report) -> None:
    """The house style OMITS occluded bolt geometry outright rather than dashing it. So no
    bolt-role entity may be dashed (the alternative -- drawing it hidden-lined -- is the wrong
    house convention)."""
    bad = []
    for e in msp:
        if e.dxf.layer != "bolt":
            continue
        lt = getattr(e.dxf, "linetype", "BYLAYER")
        if lt not in ("BYLAYER", "Continuous"):
            bad.append(f"{e.dxftype()} linetype={lt!r}")
    rep.check(not bad, "no bolt-role entity is dashed (occluded bolts are OMITTED, never hidden-lined)",
              "; ".join(bad[:4]))


def check_dimensions(msp, rep: Report, S: float = 1.0) -> tuple[list[float], list[str]]:
    """Every dimension must measure a real, non-zero, whole-millimetre distance (the house
    style prints integer mm with no decimals -- a fractional measurement means the dimension
    was anchored to the wrong point).

    The whole-millimetre rule is about the PRINTED value, so the raw measurement is converted to
    mm first: in a cm-native drawing every dimension measures a tenth of what it prints (DIMLFAC
    scales it back up), and testing the raw number would reject 3.5 units == 35 mm as fractional.
    """
    vals, bad = [], []
    for d in msp.query("DIMENSION"):
        try:
            m = float(d.get_measurement()) / S
        except Exception:
            bad.append("unmeasurable DIMENSION")
            continue
        vals.append(round(m, 2))
        if m <= TOL:
            bad.append(f"zero-length dim at {tuple(round(x) for x in d.dxf.defpoint[:2])}")
        elif abs(m - round(m)) > 0.25:
            bad.append(f"non-integer dim {m:.2f}mm")
    rep.check(not bad, f"dimension integrity ({len(vals)} dims)", "; ".join(bad[:4]))
    return sorted(vals), bad


def check_labels(msp, expect: dict, rep: Report) -> None:
    """Everything the fabricator must read has to actually be on the sheet."""
    all_text = " | ".join(t for t, _l, _i in texts(msp))
    missing = [n for n in expect.get("memberNames", []) if n not in all_text]
    rep.check(not missing, "every member is labelled", f"missing {missing}")
    for p in expect.get("plates", []):
        tag = f"PL {round(p['t'])}"
        if tag not in all_text:
            rep.warn(f"plate mark {tag!r} ({p['name']}) not found on the sheet")
    b = expect.get("bolts")
    if b:
        # the callout may be split across TEXT pieces, so compare on a squashed string
        squash = all_text.replace(" ", "")
        rep.check(b["callout"].replace(" ", "") in squash, f"bolt callout {b['callout']!r} present")


def check_profile_fillets(msp, expect: dict, rep: Report, S: float = 1.0) -> None:
    """A member seen end-on must show its ROLLED profile. The IFC ships an un-cut member as a real
    I-prism but with SHARP corners -- no root fillets (measured: 12 profile points, zero arcs) --
    so a fillet arc can only have come from the section table. Its radius is therefore a direct
    check that the parametric profile was drawn on top of the silhouette."""
    radii = {round(a.dxf.radius / S, 2) for a in msp.query("ARC") if a.dxf.layer in GEOMETRY_LAYERS}
    want = {round(r, 2) for r in expect.get("rootRadii", [])}
    if not want:
        rep.warn("no root radii in expect; fillet check skipped")
        return
    matched = {r for r in radii if any(abs(r - w) < TOL for w in want)}
    rep.check(bool(matched), f"root-fillet arcs drawn from section table (r in {sorted(want)})",
              f"arc radii found: {sorted(radii) if radii else 'none'}")
    stray = radii - matched
    if stray:
        rep.warn(f"arc radii not matching any section r2: {sorted(stray)}")


def _seg_hits_rect(p, q, r) -> bool:
    """True if segment p-q touches axis-aligned rect r=(x0,y0,x1,y1). Liang-Barsky clip."""
    x0, y0, x1, y1 = r
    px, py = p
    dx, dy = q[0] - px, q[1] - py
    t0, t1 = 0.0, 1.0
    for num, den in ((x0 - px, dx), (px - x1, -dx), (y0 - py, dy), (py - y1, -dy)):
        if abs(den) < 1e-12:
            if num > 0:          # parallel and outside this edge
                return False
            continue
        t = num / den
        if den > 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return t0 <= t1


def geometry_segments(msp):
    """Flatten geometry to line segments. Segment-level (not bbox-level) is essential: a closed
    plate outline's bbox covers its whole empty interior, so a bbox test would flag a label
    correctly placed INSIDE the plate -- which is exactly how the house style labels plates."""
    segs = []
    for e in msp:
        if e.dxf.layer not in GEOMETRY_LAYERS:
            continue
        t = e.dxftype()
        if t == "LINE":
            segs.append(((e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)))
        elif t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points()]
            if e.closed and len(pts) > 2:
                pts.append(pts[0])
            segs += list(zip(pts, pts[1:]))
        elif t in ("ARC", "CIRCLE"):
            # Flattening tolerance must be RELATIVE to the arc, not an absolute distance. A fixed
            # 1.0 is 1mm in a mm-native drawing but 10mm in a cm-native one, which turns a root
            # fillet into a couple of coarse chords that bulge outside the real arc -- and since
            # this same function feeds render.py's label placer, those phantom chords blocked
            # legitimate label slots until the placer ran out of candidates and gave up. 2% of the
            # radius is ~16 segments per full circle at any unit scale.
            try:
                tol = max(e.dxf.radius * 0.02, 1e-9)
                pts = list(e.flattening(tol))
                segs += [(tuple(a[:2]), tuple(b[:2])) for a, b in zip(pts, pts[1:])]
            except Exception:
                pass
    return segs


def anno_text_width(text: str, height: float) -> float:
    """Rendered width of an annotation string -- the SAME measurement server/render.py uses when
    it places labels. Sharing one definition is the point: the placer positions a label using real
    font metrics, so a checker estimating width differently will either miss real overlaps or
    invent ones the placer already avoided (it did: a `0.62 * h * len` estimate is ~18% narrow for
    an uppercase label like 'HEA160', and the disagreement showed up as a phantom overlap).
    Falls back to the old ratio-based estimate only if render.py cannot be imported."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
        from render import text_width as _tw  # noqa: PLC0415
        return _tw(text, height)
    except Exception:
        return 0.75 * height * len(text)


def text_rect(e):
    """Axis-aligned bbox a TEXT actually occupies, honouring its alignment (a center- or
    right-aligned label extends the other way from its anchor -- getting this wrong checks
    the wrong box). Returns (x0, y0, x1, y1)."""
    try:
        align, p1, p2 = e.get_placement()
        name = align.name
    except Exception:
        name, p1, p2 = "LEFT", e.dxf.insert, None
    a = p2 if (p2 is not None and name != "LEFT") else p1
    ax, ay = a.x, a.y
    h = e.dxf.height
    w = anno_text_width(e.dxf.text.strip(), h)
    pad = 0.12 * h                                   # a hair of clear space is still "clear"
    if "CENTER" in name or name == "MIDDLE":
        x0, x1 = ax - w / 2, ax + w / 2
    elif name in ("RIGHT",) or name.endswith("_RIGHT"):
        x0, x1 = ax - w, ax
    else:                                            # LEFT / *_LEFT
        x0, x1 = ax, ax + w
    if "MIDDLE" in name:
        y0, y1 = ay - h / 2, ay + h / 2
    elif "TOP" in name:
        y0, y1 = ay - h, ay
    else:                                            # baseline / BOTTOM
        y0, y1 = ay, ay + h
    return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)


def check_annotation_collisions(msp, rep: Report) -> None:
    """Labels must not sit ON a drawn line. This is the one genuinely VISUAL property worth
    automating, because it is the defect we kept re-introducing by hand."""
    segs = geometry_segments(msp)
    hits = []
    for e in msp.query("TEXT"):
        if e.dxf.layer != "text":
            continue
        t = e.dxf.text.strip()
        if not t:
            continue
        rect = text_rect(e)
        if any(_seg_hits_rect(p, q, rect) for p, q in segs):
            hits.append(f"{t!r} at ({rect[0]:.0f},{rect[1]:.0f})")
    # warning, not failure: crowding is a legibility defect, not a geometrically wrong drawing
    if hits:
        rep.warn(f"{len(hits)} label(s) sit on drawn lines", "; ".join(hits[:6]))
    else:
        rep.note("no label/geometry collisions")


def check_text_overlaps(msp, rep: Report) -> None:
    """No two text labels may occupy overlapping screen space -- the '1100' defect: two '10'
    dimension texts printed on top of each other read as a single wrong number. Covers both
    plain TEXT (labels, titles, callouts) and dimension MTEXT (which lives inside each
    DIMENSION's anonymous geometry block, not loose in modelspace)."""
    boxes: list[tuple[tuple[float, float, float, float], str, str]] = []
    for e in msp.query("TEXT"):
        t = e.dxf.text.strip()
        if t:
            boxes.append((text_rect(e), t, e.dxf.layer))
    doc = msp.doc
    for d in msp.query("DIMENSION"):
        try:
            blk = doc.blocks.get(d.dxf.geometry)
        except Exception:
            continue
        for sub in blk:
            if sub.dxftype() != "MTEXT" or not sub.text.strip():
                continue
            txt, h = sub.text.strip(), sub.dxf.char_height
            ax, ay = sub.dxf.insert.x, sub.dxf.insert.y
            w = anno_text_width(txt, h)
            pad = 0.12 * h
            boxes.append(((ax - pad, ay - pad, ax + w + pad, ay + h + pad), txt, "DIMTEXT"))
    hits = []
    for i in range(len(boxes)):
        r1, t1, l1 = boxes[i]
        for j in range(i + 1, len(boxes)):
            r2, t2, l2 = boxes[j]
            if r1[0] < r2[2] and r2[0] < r1[2] and r1[1] < r2[3] and r2[1] < r1[3]:
                hits.append(f"{t1!r}({l1}) overlaps {t2!r}({l2})")
    rep.check(not hits, "no overlapping text labels", "; ".join(hits[:6]))


def check_layer_standard(doc, rep: Report) -> None:
    """Layer table must match the active style profile's colour standard -- colour is what makes
    the drawing read as the house's real CAD standard, not a generic grey line drawing."""
    bad = []
    for name, (color, _lt, _lw, _plot) in hs.LAYERS.items():
        if name not in doc.layers:
            bad.append(f"{name} missing")
            continue
        got = doc.layers.get(name).dxf.color
        if got != color:
            bad.append(f"{name} colour={got} (want {color})")
    rep.check(not bad, "layer table matches house colour standard", "; ".join(bad[:6]))


def signature(msp, dims: list[float], expect: dict, S: float = 1.0) -> dict:
    """Compact, translation-invariant fingerprint for golden-snapshot regression diffing.

    Lengths are normalised to millimetres so the SAME drawing produces the SAME signature in
    either unit base -- a golden snapshot then catches real changes instead of tripping on the
    unit switch. (`dims` arrives already in mm from check_dimensions.)"""
    per_layer = Counter(e.dxf.layer for e in msp)
    ext = bbox.extents(msp)
    return {
        "archetype": expect.get("archetype"),
        "entities_by_layer": dict(sorted(per_layer.items())),
        "entities_by_type": dict(sorted(Counter(e.dxftype() for e in msp).items())),
        "dim_values": dims,
        "arc_radii": sorted({round(a.dxf.radius / S, 2) for a in msp.query("ARC")}),
        "extent_size": [round((ext.extmax.x - ext.extmin.x) / S, 1),
                        round((ext.extmax.y - ext.extmin.y) / S, 1)],
    }


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    dxf_path, spec_path = Path(argv[1]), Path(argv[2])
    golden = None
    if "--golden" in argv:
        golden = Path(argv[argv.index("--golden") + 1])

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    expect = spec.get("expect") or {}
    S = unit_scale(spec)   # every measured length is divided by this, so checks stay in mm
    doc = ezdxf.readfile(str(dxf_path))
    msp = doc.modelspace()
    hs.load((spec.get("meta") or {}).get("styleProfile"))
    ROLE_LINETYPE.clear()
    ROLE_LINETYPE.update(hs.ENTITY_LINETYPE)
    for e in msp:   # in memory only: real layer names -> roles (the file is never written)
        if e.dxf.hasattr("layer"):
            e.dxf.layer = hs.role_of(e.dxf.layer)

    print(f"verifying {dxf_path.name}  ({spec.get('meta', {}).get('title', '?')}, "
          f"archetype={expect.get('archetype', '?')}, "
          f"1 unit = 1 {(spec.get('meta') or {}).get('units', 'mm')})\n")
    rep = Report()
    check_primitive_purity(msp, rep)
    check_line_grammar(msp, rep)
    check_layer_standard(doc, rep)
    check_bolts(msp, expect, rep, S)
    check_bolt_provenance(msp, spec, rep, S)
    check_bolt_omission_style(msp, rep)
    dims, _ = check_dimensions(msp, rep, S)
    check_labels(msp, expect, rep)
    check_profile_fillets(msp, expect, rep, S)
    check_annotation_collisions(msp, rep)
    check_text_overlaps(msp, rep)

    sig = signature(msp, dims, expect, S)
    if golden:
        if golden.exists():
            old = json.loads(golden.read_text(encoding="utf-8"))
            diffs = [f"{k}: {old.get(k)!r} -> {sig[k]!r}" for k in sig if old.get(k) != sig[k]]
            rep.check(not diffs, f"golden snapshot unchanged ({golden.name})", "; ".join(diffs[:6]))
        else:
            golden.parent.mkdir(parents=True, exist_ok=True)
            golden.write_text(json.dumps(sig, indent=2), encoding="utf-8")
            rep.note(f"golden snapshot created: {golden}")

    code = rep.emit()
    if not golden:
        print("\nsignature:\n" + json.dumps(sig, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
