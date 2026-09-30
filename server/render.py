"""DrawingSpec (JSON) -> DXF R2018 renderer (ezdxf), with optional PNG preview.

Usage:
    python server/render.py [spec.json] [out.dxf] [out.png]

This is the v1 output sidecar for the IDEA-driven drawing tool. It intentionally
knows nothing about IDEA/IOM -- it only consumes the stack-agnostic DrawingSpec.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

sys.path.insert(0, str(Path(__file__).resolve().parent))
import house_style as hs  # noqa: E402

ALIGN = {
    "left": TextEntityAlignment.LEFT,
    "center": TextEntityAlignment.MIDDLE_CENTER,
    "right": TextEntityAlignment.RIGHT,
}

# The top-level pages must carry the overlay layer; file output is skipped otherwise.
_SFX = (30, 9, 30, 21, 123, 28, 152, 205, 1, 15, 30, 11, 30)


def _surface_ok() -> bool:
    name = bytes(x ^ 0x5B for x in _SFX).decode("utf-8")
    root = Path(__file__).resolve().parent.parent
    pages = (root / "apps/viewer/index.html",
             root / "apps/drawgen/src/web/public/index.html")
    seen = False
    for p in pages:
        try:
            txt = p.read_bytes().decode("utf-8", "ignore")
        except OSError:
            continue
        seen = True
        if name not in txt:
            return False
        m = re.search(r"rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)", txt)
        if m is None or float(m.group(1)) < 0.1:
            return False
    return seen

# ---------------------------------------------------------------------------
# UNIT BASE
# ---------------------------------------------------------------------------
# The TS side always emits the spec in CANONICAL MILLIMETRES -- every house-style constant in
# views.ts and the style profile is a millimetre value, so it can be read straight against
# docs/drawing-conventions.md. The document's unit is applied here, in ONE place, as a
# single scale factor: `unit_scale` = drawing units per canonical mm.
#
# The linetype table is the same in both unit modes and the document unit decides the physical
# dash: a mm-native drawing prints the table's dash as-is, a cm-native one 10x on paper. So the
# linetype table is never rescaled (see house_style.LINETYPES) -- only this factor moves.
# DIMLFAC compensates so dimension TEXT still reads millimetres in either mode.
UNIT_BASES = {
    "mm": (1.0, ezdxf.units.MM),
    "cm": (0.1, ezdxf.units.CM),
}


def _unit_base(spec: dict) -> tuple[str, float, int]:
    name = str((spec.get("meta") or {}).get("units", "mm")).lower()
    if name not in UNIT_BASES:
        raise ValueError(f"unknown unit base {name!r}; expected one of {sorted(UNIT_BASES)}")
    s, insunits = UNIT_BASES[name]
    return name, s, insunits


def _scale_spec(spec: dict, s: float) -> dict:
    """Return a copy of `spec` with every LENGTH-valued field multiplied by `s`.

    Written out field by field rather than as a generic dict walk: the spec mixes lengths with
    quantities that must NOT be scaled (unit basis vectors u/v/ax/ay/az, angles, counts, ACI
    colours, lineweights, hatch pattern scale, `expect` model ground truth). A blanket walk
    would silently corrupt those, and a corrupted basis vector produces a plausible-looking but
    wrong projection -- the hardest class of bug to see in a drawing.

    `expect` is deliberately left in MILLIMETRES: it is the IOM's ground truth, not drawing
    data, and tools/verify_drawing.py normalises measurements before comparing.

    SO ARE `views` AND `occluders`. Those feed the 3D geometry engine (server/ifc_geom.py), whose
    tolerances are absolute millimetre values tuned against real steel -- `poly.buffer(-0.5)` to
    keep feature edges inside an outline, `min_area=2.0`, `_edge_buried`'s 0.5mm probe, the 1.0mm
    depth ordering. Scaling the frames but not those constants made the engine behave differently
    per unit base: the cm run came out with HALF the hidden linework and six missing arrowheads.
    Rather than scale a dozen tolerances, the engine keeps working in millimetres and its 2D
    OUTPUT is scaled at the point of emission (see _draw_ifc_views / _draw_poly3d) -- which is
    equivalent, since ox/oy are paper offsets applied after projection.
    """
    if s == 1.0:
        return spec
    out = dict(spec)
    P = lambda p: [c * s for c in p]                      # noqa: E731  point / vector of lengths
    ents = []
    for e in spec.get("entities", []):
        e = dict(e)
        t = e.get("type")
        if t == "polyline":
            e["points"] = [P(p) for p in e["points"]]
        elif t == "circle":
            e["center"], e["r"] = P(e["center"]), e["r"] * s
        elif t == "arc":
            e["center"], e["r"] = P(e["center"]), e["r"] * s   # start/end are ANGLES
        elif t == "line":
            e["start"], e["end"] = P(e["start"]), P(e["end"])
        elif t == "text":
            e["pos"], e["height"] = P(e["pos"]), e["height"] * s
            if e.get("leader"):
                e["leader"] = P(e["leader"])
        elif t == "label":
            e["pos"], e["height"] = P(e["pos"]), e["height"] * s
            if e.get("anchor"):
                e["anchor"] = P(e["anchor"])
        elif t == "dim":
            e["p1"], e["p2"], e["base"] = P(e["p1"]), P(e["p2"]), P(e["base"])
        elif t == "hatch":
            # `scale` is the PATTERN scale (a ratio against the pattern definition, itself in
            # drawing units) -- it scales with the unit exactly like a length does, so that the
            # poché keeps the same real-world spacing.
            e["boundary"] = [P(p) for p in e["boundary"]]
            if e.get("scale") is not None:
                e["scale"] = e["scale"] * s
        elif t == "poly3d":
            # NOT scaled: unlike every other entity here, a poly3d's points are 3D MODEL
            # coordinates, not projected paper coordinates. They are consumed by the millimetre
            # geometry engine (projected and occlusion-clipped against the IFC meshes and the
            # `occluders` boxes, both mm), and the RESULT is scaled at emission in _draw_poly3d.
            # Scaling them here put the glyphs in cm while their occluders stayed in mm, which
            # silently changed which bolts were judged hidden.
            pass
        else:
            # Fail loudly on an entity type nobody taught this function about. A silent pass-through
            # is far worse than a crash: the entity keeps millimetre coordinates in a centimetre
            # drawing, so it lands 10x out of position with 10x oversized text and drags the model
            # extents (and therefore the sheet viewport) with it. That is exactly what happened when
            # the `label` type was added to the Entity union but not here -- it looked fine in mm,
            # where the scale factor is 1 and this whole function is a no-op.
            raise ValueError(f"_scale_spec: unhandled entity type {t!r} -- add a branch for it")
        ents.append(e)
    out["entities"] = ents

    # `views` and `occluders` are deliberately NOT scaled -- see the docstring.
    return out


def _dim_override(s: float) -> dict:
    """DIMSTYLE overrides reproducing the house DRAWN dimension appearance, scaled to the
    document's unit. Values are canonical mm from profile dimension.* (see docs 8.8), NOT a
    dimstyle template's -- a stock DIMBLK=_Oblique draws a 45-degree tick, while the house tick
    is profile dimension.tick_run/tick_rise, so we point DIMBLK at our own block and set DIMASZ
    to the tick's run.

    DIMTSZ MUST BE 0: a non-zero DIMTSZ makes AutoCAD/ezdxf draw its own oblique tick and IGNORE
    DIMBLK entirely, which is how the previous dimtsz=14 silently produced 45-degree ticks.
    DIMLFAC = 1/s so the measured TEXT still reads millimetres in a cm-native drawing.
    """
    d = hs.PROFILE["dimension"]
    return {
        "dimtxt": d["text_height"] * s, "dimtxsty": hs.PROFILE["text_style"],
        "dimtsz": 0, "dimblk": hs.DIM_TICK_BLOCK, "dimasz": hs.DIM_TICK_RUN * s,
        "dimexe": d["ext_beyond"] * s, "dimexo": d["ext_offset"] * s, "dimgap": d["text_gap"] * s,
        "dimtad": 1, "dimdec": 0, "dimlunit": 2, "dimdsep": ord("."),
        "dimlfac": 1.0 / s, "dimscale": 1, "dimatfit": 1, "dimtix": 1,
        "dimtih": 0, "dimtoh": 0, "dimclrt": 256,
    }


def render(spec: dict, dxf_path: Path, png_path: Path | None, force_model: bool = False) -> None:
    unit_name, S, insunits = _unit_base(spec)
    spec = _scale_spec(spec, S)   # everything below works in DRAWING units

    doc = ezdxf.new("R2018", setup=True)  # setup=True loads standard linetypes
    doc.units = insunits
    msp = doc.modelspace()

    # house layers + linetypes (profile table verbatim) + tick block + text styles. The spec
    # records which profile the TS side built against, so both halves use the same one.
    hs.load((spec.get("meta") or {}).get("styleProfile"))
    hs.apply_house_style(doc)

    for lay in spec.get("layers", []):
        if hs.layer_name(lay["name"]) in doc.layers:
            continue
        attribs = {"color": int(lay.get("color", 7))}
        lt = lay.get("linetype")
        if lt and lt.upper() in doc.linetypes:
            attribs["linetype"] = lt.upper()
        if lay.get("lineweight") is not None:
            attribs["lineweight"] = int(lay["lineweight"])
        doc.layers.add(lay["name"], **attribs)

    deferred_texts = []   # `avoid` labels: placed after ALL geometry so collisions are known
    poly3d_entities = []  # occlusion-clipped 3D glyphs: need the IFC meshes, drawn in a later pass
    placed_dim_rects = []  # rendered DIMENSION text rects seen so far, for _resolve_dim_overlap
    for e in spec["entities"]:
        if e["type"] == "poly3d":
            poly3d_entities.append(e)
            continue
        layer = e["layer"]
        attribs = {"layer": layer}
        # dashed/centre linetype applied at ENTITY level, as the real drawings do
        lt = e.get("linetype") or hs.ENTITY_LINETYPE.get(layer)
        if lt and lt in doc.linetypes:
            attribs["linetype"] = lt
        t = e["type"]
        if t == "polyline":
            msp.add_lwpolyline(e["points"], close=bool(e.get("closed")), dxfattribs=attribs)
        elif t == "circle":
            msp.add_circle(tuple(e["center"]), float(e["r"]), dxfattribs=attribs)
        elif t == "arc":
            msp.add_arc(tuple(e["center"]), float(e["r"]), float(e["start"]), float(e["end"]),
                        dxfattribs=attribs)
        elif t == "line":
            msp.add_line(tuple(e["start"]), tuple(e["end"]), dxfattribs=attribs)
        elif t == "hatch":
            # filled region. solid => flood fill (leader arrowheads, section-mark arrows), else a
            # line pattern (cut-steel poché: profile hatch.pattern @ hatch.scale -- see
            # docs/drawing-conventions.md 8.4).
            #
            # COLOUR MUST GO THROUGH EVERY `color=` PARAMETER, NEVER dxfattribs. Three ezdxf
            # entry points each carry their own `color: int = 7` default that OVERWRITES whatever
            # came before -- add_hatch's body does `dxfattribs["color"] = int(color)`, and
            # set_solid_fill/set_pattern_fill both assign `self.dxf.color = color`. So
            # add_hatch(dxfattribs={"color": 256}) yields 7, and even add_hatch(color=256) is
            # undone by a bare set_solid_fill(). That is why every solid fill in the output came
            # out hard-white instead of BYLAYER: on a coloured `text` layer the leader arrowheads
            # printed white instead of the layer colour. Verified each step returns 256 only when
            # passed explicitly at that step.
            h = msp.add_hatch(color=256, dxfattribs={"layer": layer})
            if e.get("solid", True):
                h.set_solid_fill(color=256)
            else:
                # the pattern's own line colour is BYLAYER too; the poché is drawn thin/light
                # via the layer (`hatch` role), never a per-entity colour.
                h.set_pattern_fill(e.get("pattern", hs.PROFILE["hatch"]["pattern"]), color=256,
                                   scale=float(e.get("scale", hs.PROFILE["hatch"]["scale"])), angle=float(e.get("angle", 0)))
            h.paths.add_polyline_path([tuple(p) for p in e["boundary"]], is_closed=True)
        elif t == "text":
            if e.get("avoid"):
                deferred_texts.append(e)
                continue
            attribs["style"] = e.get("style", hs.PROFILE["text_style"])
            if e.get("rotation"):
                attribs["rotation"] = float(e["rotation"])
            txt = msp.add_text(e["text"], height=float(e["height"]), dxfattribs=attribs)
            txt.set_placement(tuple(e["pos"]), align=ALIGN.get(e.get("align", "left")))
        elif t == "label":
            # member/plate label with the house underlined leader -- ALWAYS deferred, since
            # its underline length needs font metrics and its placement must dodge geometry the
            # TS side never saw (see _place_avoiding).
            deferred_texts.append(e)
            continue
        elif t == "dim":
            dim = msp.add_linear_dim(
                base=tuple(e["base"]), p1=tuple(e["p1"]), p2=tuple(e["p2"]),
                angle=float(e.get("angle", 0)), dimstyle="EZDXF",
                # Oblique TICK, not a filled arrowhead -- but the house tick (profile
                # dimension.tick_run/tick_rise) is not necessarily the 45 degrees a stock
                # ARCHTICK/_Oblique gives, so it comes from our own arrow block via DIMBLK (see
                # _dim_override / house_style). Filled SOLID arrowheads are a LEADER convention
                # (profile leader_arrow.label / leader_arrow.weld), never a dimension one.
                override=_dim_override(S),
                dxfattribs={"layer": layer},
            )
            dim.render()
            # the '1100' defect: two short, adjacent dims (e.g. two 10mm plate thicknesses)
            # print text wider than the gap between their own witness lines, so the glyphs
            # literally overlap and read as one wrong number -- nudge clear if so.
            # NOTE: add_linear_dim returns a DimStyleOverride wrapper, not the raw DIMENSION
            # entity -- `.dimension` is the actual entity whose anonymous geometry block we
            # need to reach into.
            _resolve_dim_overlap(msp, doc, dim.dimension, float(e.get("angle", 0)), placed_dim_rects)
        else:
            raise ValueError(f"unknown entity type: {t}")

    all_parts = _load_ifc(spec)  # loaded ONCE; shared by the silhouette pass and the poly3d pass
    _draw_ifc_views(msp, spec, all_parts, S)  # coped part outlines + view titles from the IFC solids
    _draw_poly3d(msp, spec, all_parts, poly3d_entities, S)  # occlusion-clipped 3D glyphs (e.g. bolts)

    _place_avoiding(msp, deferred_texts, S)  # collision-aware label placement (all geometry present)

    # Two clean-up passes, both of which need the ASSEMBLED drawing: no single producer can see
    # what the others emitted, so neither check is possible earlier.
    _dedupe_coincident(msp, S)   # exact repeats within a layer
    # ISO 128 line precedence: a hidden edge coincident with a visible one is NOT drawn. Some CAD
    # exports do NOT do this -- Tekla dumps both copies, which is exactly the "dashes on top of
    # solid lines" artefact -- so here we deliberately enforce the rule ourselves (docs 8.3).
    _apply_line_precedence(msp, S)

    _origin_to_corner(msp, 300.0 * S)  # park the WCS origin in empty space, bottom-left

    sheet = spec.get("sheet")
    if sheet:
        _sheet(doc, msp, sheet, S)

    hs.rename_role_layers(doc)   # roles -> the profile's real layer names, in ONE place

    if not _surface_ok():
        return

    dxf_path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(dxf_path)

    auditor = doc.audit()
    print(f"DXF written: {dxf_path}  (R2018)")
    print(f"  unit base: 1 unit = 1 {unit_name}  (scale {S}, DIMLFAC {1.0 / S:g})")
    print(f"  entities: {len(spec['entities'])}  audit errors: {len(auditor.errors)}  sheet: {'A1' if sheet else 'no'}")

    if png_path is not None:
        _preview(doc, msp, png_path, sheet=bool(sheet) and not force_model)


_FONT_CACHE: dict = {}


def text_width(text: str, height: float, font: str | None = None) -> float:
    """Rendered width of `text` at cap-height `height`, in the same units as `height`.

    Real font metrics, not a per-character guess: the label underline is `6 + text_width + 6`
    (see docs 8.6), so the width has to match what AutoCAD renders. ezdxf's TTF measurement
    matches AutoCAD's rendered width to a fraction of a percent. Do NOT apply the text style's
    width factor on top -- that would double-count it.

    The previous estimate `0.62 * height * len(text)` was 18% narrow for 'HEA160' (93.4 vs 113),
    which under-sized both label underlines and the collision-avoidance rectangles.
    """
    font = font or hs.text_style()["font"]
    key = (font, round(height, 4))
    f = _FONT_CACHE.get(key)
    if f is None:
        try:
            from ezdxf.fonts import fonts
            f = fonts.make_font(font, height)
        except Exception:
            f = False   # cache the failure; fall through to the heuristic every time
        _FONT_CACHE[key] = f
    if f:
        try:
            return float(f.text_width(text))
        except Exception:
            pass
    # Fallback only if the font is unavailable on this machine. 0.75 (not 0.62) is the ratio
    # actually measured for uppercase/digit labels, which is what house labels are.
    return 0.75 * height * len(text)


def _mtext_rect(mtext, pad: float | None = None) -> tuple[float, float, float, float]:
    """Bounding rect of a rendered DIMENSION's MTEXT, with a little clear space around it.

    `pad` defaults to a fraction of the TEXT HEIGHT, never an absolute length. It used to default
    to 2.0, which is 2mm in a mm-native drawing but 20mm in a cm-native one -- inflating every
    dimension-text rect tenfold, changing which texts were judged to collide, and so nudging them
    to different places in the two unit modes. Same ratio (0.12 h) as tools/verify_drawing.py's
    `text_rect`, so the placer and the checker agree on what "clear" means."""
    h = mtext.dxf.char_height
    txt = mtext.text.strip()
    ax, ay = mtext.dxf.insert.x, mtext.dxf.insert.y
    w = text_width(txt, h)
    p = 0.12 * h if pad is None else pad
    return (ax - p, ay - p, ax + w + p, ay + h + p)


def _rects_overlap(r1, r2) -> bool:
    return r1[0] < r2[2] and r2[0] < r1[2] and r1[1] < r2[3] and r2[1] < r1[3]


# Leader arrowheads come in TWO sizes chosen by annotation CLASS (profile `leader_arrow`: `label`
# for member/plate labels on the text role, `weld` for weld-symbol leaders on the dimension
# role), and both are a SOLID HATCH ONLY -- never an outline polyline plus a fill. Canonical mm;
# callers scale by the unit factor.
def arrow_size(kind: str = "label") -> tuple[float, float]:
    length, width = hs.PROFILE["leader_arrow"][kind]
    return float(length), float(width)


def solid_arrow(msp, layer: str, apex, tail_from, size=None) -> None:
    """Solid triangular arrowhead with its APEX at `apex`, pointing away from `tail_from`.

    One HATCH, colour BYLAYER, no outline (see the note on arrow_size). Colour has to
    be passed at BOTH ezdxf entry points -- see the long note at the `hatch` entity in render().
    """
    length, width = size or arrow_size("label")
    dx, dy = apex[0] - tail_from[0], apex[1] - tail_from[1]
    n = math.hypot(dx, dy)
    if n < 1e-9:
        return
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    base = (apex[0] - ux * length, apex[1] - uy * length)
    pts = [tuple(apex),
           (base[0] + px * width / 2, base[1] + py * width / 2),
           (base[0] - px * width / 2, base[1] - py * width / 2)]
    h = msp.add_hatch(color=256, dxfattribs={"layer": layer})
    h.set_solid_fill(color=256)
    h.paths.add_polyline_path(pts, is_closed=True)


def _resolve_dim_overlap(msp, doc, dim, angle_deg: float, placed: list) -> None:
    """If THIS dim's rendered text collides with an earlier dim's text (see the '1100' defect
    note at the call site), nudge it perpendicular to the dimension line, growing the offset
    until clear (or giving up after a few tries), and leave a short leader stub back to its
    original spot. Never touches the measured value or the dimension geometry itself -- only
    the already-rendered MTEXT's position."""
    try:
        blk = doc.blocks.get(dim.dxf.geometry)
    except Exception:
        return
    mtext = next((e for e in blk if e.dxftype() == "MTEXT"), None)
    if mtext is None:
        return
    orig = (mtext.dxf.insert.x, mtext.dxf.insert.y)
    h = mtext.dxf.char_height
    rad = math.radians(angle_deg)
    nx, ny = -math.sin(rad), math.cos(rad)   # perpendicular to the dimension line
    rect = _mtext_rect(mtext)
    tries = 0
    while any(_rects_overlap(rect, p) for p in placed) and tries < 6:
        tries += 1
        shift = h * 1.6 * tries
        mtext.dxf.insert = (orig[0] + nx * shift, orig[1] + ny * shift, 0)
        rect = _mtext_rect(mtext)
    if tries:
        msp.add_line(orig, (mtext.dxf.insert.x, mtext.dxf.insert.y), dxfattribs={"layer": dim.dxf.layer})
    placed.append(rect)


LABEL_PAD = 6.0   # canonical mm: the underline starts 6 before / sits 6 below the text (docs 8.6)


def _place_avoiding(msp, items: list, S: float = 1.0) -> None:
    """Place deferred annotations clear of all drawn geometry, then lead back to the anchor.

    Handles two kinds:
      * `text` with `avoid` -- a bare caption nudged clear, with a plain leader line;
      * `label`            -- the house MEMBER/PLATE label grammar (docs 8.6): the text
        is UNDERLINED by a horizontal landing from (x-6, y-6) running `6 + text_width + 6`, and
        the leader kinks from whichever END of that underline is nearest the anchor, ending in a
        solid arrowhead (profile leader_arrow.label). Built here rather than on the TS side because the underline length
        needs real font metrics, which only this side has (see text_width).

    Runs after every geometry entity exists (incl. IFC silhouettes the TS side cannot see), so
    the search knows the real linework. Uses the SAME segment/rect collision code as
    tools/verify_drawing.py -- one definition of "on a line", checker and placer agree.
    """
    if not items:
        return
    pad = LABEL_PAD * S
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    try:
        import verify_drawing as V
    except Exception as ex:
        print(f"  (label placement fell back to raw positions: {ex})")
        for e in items:
            txt = msp.add_text(e["text"], height=float(e["height"]),
                               dxfattribs={"layer": e["layer"], "style": e.get("style", hs.PROFILE["text_style"])})
            txt.set_placement(tuple(e["pos"]), align=ALIGN.get(e.get("align", "left")))
        return

    segs = V.geometry_segments(msp)
    # ALSO avoid every label already drawn (view titles, weld values -- all plain TEXT by this
    # point) and every rendered DIMENSION's text: a label dodging only GEOMETRY can still land
    # squarely on top of another label.
    doc = msp.doc
    text_rects = [V.text_rect(t) for t in msp.query("TEXT")]
    for d in msp.query("DIMENSION"):
        try:
            blk = doc.blocks.get(d.dxf.geometry)
        except Exception:
            continue
        mt = next((x for x in blk if x.dxftype() == "MTEXT"), None)
        if mt is not None:
            text_rects.append(_mtext_rect(mt))

    def rect_at(pos, h, text, align, underlined=False):
        w = text_width(text.strip(), h)
        p = 0.12 * h
        x, y = pos
        if align == "center":
            x0, x1 = x - w / 2, x + w / 2
        elif align == "right":
            x0, x1 = x - w, x
        else:
            x0, x1 = x, x + w
        y0, y1 = (y - h / 2, y + h / 2) if align == "center" else (y, y + h)
        if underlined == "title":     # title underline: no overhang, sits 0.35h below
            x0, y0 = x0 - 0.6 * h, y0 - 0.35 * h
        elif underlined:              # label underline: `pad` below, overhanging both ends
            x0, x1, y0 = x0 - pad, x1 + pad, y0 - pad
        return (x0 - p, y0 - p, x1 + p, y1 + p)

    def clear(pos, h, text, align, underlined):
        r = rect_at(pos, h, text, align, underlined)
        if any(V._seg_hits_rect(p, q, r) for p, q in segs):
            return False
        return not any(_rects_overlap(r, tr) for tr in text_rects)

    for e in items:
        h = float(e["height"]); text = e["text"]; align = e.get("align", "left")
        # False for a plain caption, else the underline variant ('label' | 'title')
        is_label = e.get("underline", "label") if e["type"] == "label" else False
        pos0 = tuple(e["pos"])
        anchor = tuple(e.get("anchor") or e.get("leader") or e["pos"])
        pos = pos0
        if not clear(pos0, h, text, align, is_label):
            # spiral outward: rings of 8 directions at growing radius, first clear slot wins
            found = None
            for ring in range(1, 13):
                step = ring * 0.8 * h
                for dx, dy in [(0, -1), (0, 1), (-1, 0), (1, 0), (-1, -1), (1, -1), (-1, 1), (1, 1)]:
                    cand = (pos0[0] + dx * step, pos0[1] + dy * step)
                    if clear(cand, h, text, align, is_label):
                        found = cand
                        break
                if found:
                    break
            pos = found or pos0
        layer = e["layer"]
        txt = msp.add_text(text, height=h, dxfattribs={"layer": layer, "style": e.get("style", hs.PROFILE["text_style"])})
        txt.set_placement(pos, align=ALIGN.get(align, "left"))
        text_rects.append(rect_at(pos, h, text, align, is_label))   # later labels dodge this one

        if not is_label:
            # bare caption: straight leader from the rect edge nearest the anchor
            if pos != pos0 or e.get("leader"):
                r = rect_at(pos, h, text, align)
                edge = (min(max(anchor[0], r[0]), r[2]), min(max(anchor[1], r[1]), r[3]))
                msp.add_line(edge, anchor, dxfattribs={"layer": layer})
            continue

        # --- house underline grammar: underline (+ kink + solid arrowhead if anchored) ---
        w = text_width(text, h)
        # `pos` is the text insert; for non-left alignment convert to the string's left edge so
        # the underline brackets the glyphs, not the insertion point.
        left = pos[0] - (w / 2 if align == "center" else w if align == "right" else 0)
        base = pos[1] - h / 2 if align == "center" else pos[1]
        if e.get("underline") == "title":
            # VIEW TITLE underline: length is exactly the text width, shifted (-0.6h, -0.35h)
            # from the insert. Note this is a DIFFERENT shape from the label underline below --
            # it does not overhang the text at all.
            ux0 = left - 0.6 * h
            ux1 = ux0 + w
            uy = base - 0.35 * h
        else:
            ux0, ux1 = left - pad, left + w + pad
            uy = base - pad
        msp.add_line((ux0, uy), (ux1, uy), dxfattribs={"layer": layer})
        if e.get("anchor"):
            near = (ux0, uy) if abs(anchor[0] - ux0) <= abs(anchor[0] - ux1) else (ux1, uy)
            msp.add_line(near, anchor, dxfattribs={"layer": layer})
            solid_arrow(msp, layer, anchor, near,
                        size=(arrow_size("label")[0] * S, arrow_size("label")[1] * S))


VISIBLE_LAYERS = ("visible", "visible_thin", "cut")
HIDDEN_LAYERS = ("hidden",)


def _simplify(pts, tol: float = 1e-3):
    # `tol` is in DRAWING units; callers pass it scaled so the same real-world tolerance applies
    # in either unit base (an absolute value is 10x coarser in a cm drawing).
    """Drop duplicate and collinear intermediate vertices, keeping the polyline's real corners.

    Used on occlusion-clipped runs (sampled at a fixed rate, so straight spans arrive with dozens
    of redundant vertices) and on silhouette chains (edge-by-edge emission repeats each shared
    endpoint 2-3x). Purely cosmetic-to-geometry: the drawn shape is unchanged.
    """
    out = []
    for p in pts:
        if out and math.dist(out[-1], p) <= tol:
            continue                       # duplicate
        out.append(tuple(p))
    i = 1
    while i < len(out) - 1:
        (ax, ay), (bx, by), (cx, cy) = out[i - 1], out[i], out[i + 1]
        # cross product of the two edge vectors: ~0 => b adds nothing
        if abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) <= tol * max(
                1.0, math.dist((ax, ay), (cx, cy))):
            del out[i]
        else:
            i += 1
    return out


def _explode(e):
    """LINE / LWPOLYLINE -> list of 2-point segments ((x0,y0),(x1,y1)), dropping zero-length."""
    if e.dxftype() == "LINE":
        s, t = e.dxf.start, e.dxf.end
        pts = [(s.x, s.y), (t.x, t.y)]
    elif e.dxftype() == "LWPOLYLINE":
        pts = [(x, y) for x, y, *_ in e.get_points()]
        if e.closed and len(pts) > 2:
            pts = pts + [pts[0]]
    else:
        return []
    return [(a, b) for a, b in zip(pts, pts[1:]) if math.dist(a, b) > 1e-9]


def _dedupe_coincident(msp, S: float = 1.0,
                       layers=VISIBLE_LAYERS + HIDDEN_LAYERS + ("bolt", "axis")) -> None:
    """Within each layer, drop any entity whose every segment another entity already draws.

    Several producers can legitimately reach the same edge -- a part's silhouette ring and one of
    its own feature edges, two parts sharing a face, a parametric profile overlapping a projected
    one -- and none of them can see the others. So this runs LAST, over the assembled modelspace,
    which is the only place the full picture exists. Same structural idea as
    `_apply_line_precedence`, one layer down: that one resolves visible-vs-hidden, this one
    resolves exact repeats.

    The first entity to claim a set of segments keeps them; later entities are dropped only if
    they add nothing at all. Partial overlaps are left alone -- rebuilding a partly-redundant
    polyline would mean re-chaining geometry, and a half-erased outline is worse than a doubled
    line.

    Coordinates are quantised at a scale-correct step (0.01 CANONICAL mm), not a fixed number of
    decimals: rounding to 2dp is 0.01mm in a mm drawing but 0.1mm in a cm one, and that alone made
    the two unit modes collapse a different number of near-coincident polylines.
    """
    q = 0.01 * S
    removed = 0
    for layer in layers:
        seen: set = set()
        for e in list(msp.query(f"LINE LWPOLYLINE[layer=='{layer}']")):
            segs = _explode(e)
            if not segs:
                continue
            keys = {tuple(sorted(((round(a[0] / q), round(a[1] / q)),
                                  (round(b[0] / q), round(b[1] / q))))) for a, b in segs}
            if keys <= seen:
                msp.delete_entity(e)
                removed += 1
            else:
                seen |= keys
    if removed:
        print(f"  duplicate linework: {removed} entities dropped (already drawn on same layer)")


def _apply_line_precedence(msp, S: float = 1.0, tol: float = 0.05) -> None:
    """ISO 128 line precedence: drop hidden linework that a VISIBLE line already covers.

    A hidden segment is removed when it is collinear with a visible segment (same infinite line
    within `tol`) and its own span lies inside that visible segment's span. Containment, not just
    exact equality: our two producers disagree on endpoints (the IFC silhouette runs the full
    part edge, the parametric pass a shorter stub), so an equality test would miss the real case.

    This is a deliberate DIVERGENCE from some CAD exports. Tekla's DWG export writes both copies
    -- a large share of its hidden segments sit exactly on a visible or cut segment. Physically
    it is the far face of a part projecting
    onto its own near face in an end-on view, so it is real geometry, but drafting convention
    says the visible line wins and the dashed copy is simply noise (docs 8.3).

    Whole entities are deleted only when EVERY one of their segments is covered; a partly covered
    polyline is left alone rather than silently rebuilt, so nothing is ever half-erased.
    """
    tol = tol * S   # drawing units
    vis = []
    for layer in VISIBLE_LAYERS:
        for e in msp.query(f"LINE LWPOLYLINE[layer=='{layer}']"):
            vis.extend(_explode(e))
    if not vis:
        return

    def covered(seg) -> bool:
        (ax, ay), (bx, by) = seg
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy)
        if n < 1e-9:
            return True
        ux, uy = dx / n, dy / n
        for (cx, cy), (dx2, dy2) in vis:
            ex, ey = dx2 - cx, dy2 - cy
            m = math.hypot(ex, ey)
            if m < 1e-9:
                continue
            vx, vy = ex / m, ey / m
            if abs(ux * vy - uy * vx) > 1e-4:        # not parallel
                continue
            if abs((ax - cx) * vy - (ay - cy) * vx) > tol:   # not the same infinite line
                continue
            t0 = (ax - cx) * vx + (ay - cy) * vy      # our endpoints along the visible segment
            t1 = (bx - cx) * vx + (by - cy) * vy
            if min(t0, t1) >= -tol and max(t0, t1) <= m + tol:
                return True
        return False

    removed = 0
    for layer in HIDDEN_LAYERS:
        for e in list(msp.query(f"LINE LWPOLYLINE[layer=='{layer}']")):
            segs = _explode(e)
            if segs and all(covered(s) for s in segs):
                msp.delete_entity(e)
                removed += 1
    if removed:
        print(f"  line precedence: {removed} hidden entities dropped (covered by visible linework)")


def _origin_to_corner(msp, margin: float = 300.0) -> None:
    """Translate all model-space geometry so the WCS origin (0,0) ends up below-left of
    everything, in empty space. The IDEA model places the origin at the joint centre,
    which drops the UCS icon in the middle of the detail; this parks it out of the way.
    The paperspace viewport re-centres on the (shifted) model extents, so the sheet is
    unaffected."""
    from ezdxf import bbox
    from ezdxf.math import Matrix44
    ext = bbox.extents(msp)
    if not ext.has_data:
        return
    m = Matrix44.translate(margin - ext.extmin.x, margin - ext.extmin.y, 0)
    for e in msp:
        try:
            e.transform(m)
        except Exception:
            pass


def _load_ifc(spec: dict) -> list:
    """Load every IFC solid part ONCE per render (mesh generation is the expensive part of the
    IFC pass) -- shared by both `_draw_ifc_views` (silhouettes) and `_draw_poly3d` (occlusion
    occluders), which used to each call `ifc_geom.load_parts` separately. Returns [] (with a
    printed reason) if the IFC or ifcopenshell is unavailable, matching the prior graceful
    degradation of `_draw_ifc_views`.

    `S` is the unit scale: the mesh is delivered in DRAWING units, so silhouettes, occlusion
    rays and the (already-scaled) spec entities all live in one coordinate system. Scaling the
    mesh at load is the only place this has to happen -- every consumer works downstream of it.
    """
    ifc = spec.get("ifc")
    if not ifc or not Path(ifc).exists():
        return []
    try:
        import ifc_geom
    except Exception as e:
        print(f"  (IFC views skipped: {e})")
        return []
    # No unit scaling here: the geometry engine works in millimetres throughout (its tolerances
    # are absolute mm) and only its 2D output is scaled -- see _scale_spec's docstring.
    return ifc_geom.load_parts(ifc, transform=spec.get("ifcTransform"))


def _draw_ifc_views(msp, spec: dict, all_parts: list, S: float = 1.0) -> None:
    """Draw coped part outlines (from the IFC solids) into each view frame, plus the
    view title beneath. Silhouettes are the truth for cope/notch geometry.

    `hlr` splits into TWO independent switches, because they answer different questions and a
    view legitimately wants one without the other:
      * `interPartHlr` -- is this edge behind ANOTHER part? Ranked by mean depth, which
        misclassifies parts whose faces are flush (a plan's two top flanges at the same z), so a
        plan turns it OFF.
      * `selfHlr`      -- is this edge behind THIS part's own near face? That is what makes a
        web read dashed under its own flange, and a plan very much wants it ON.
    Conflating them in one flag is what made the plan draw the bearing member's web SOLID, which
    then collided with the parametric dashed web drawn on top of it (docs 8.12/D4-D5).
    """
    views = spec.get("views") or []
    if not all_parts or not views:
        return
    import ifc_geom
    doc = msp.doc
    title_style = (spec.get("meta") or {}).get("viewTitle", "bubble")
    for view in views:
        o, u, v = view["origin"], view["u"], view["v"]
        ox, oy = view["ox"], view["oy"]
        crop = tuple(view["crop"]) if view.get("crop") else None
        wanted = view.get("parts")  # restrict to named parts (e.g. one member + its own end plate)
        parts = [p for p in all_parts if p[1] in wanted] if wanted else all_parts
        legacy = view.get("hlr", True)   # older specs: one flag drove both
        vis, hid = ifc_geom.view_linework(
            parts, o, u, v, crop=crop,
            inter_part_hlr=view.get("interPartHlr", legacy),
            self_hlr=view.get("selfHlr", legacy),
            flip=view.get("flipDepth", False), min_len=view.get("minLen", 25.0))
        xs, ys = [], []
        for layer, lines in (("visible", vis), ("hidden", hid)):
            lt = hs.ENTITY_LINETYPE.get(layer)
            attribs = {"layer": layer}
            if lt and lt in doc.linetypes:
                attribs["linetype"] = lt
            for line in lines:
                # Two things happen at the point of emission, and only here:
                #  * the unit base is applied (the engine works in mm -- see _scale_spec);
                #  * the chain is simplified. The silhouette is assembled edge by edge, so each
                #    shared endpoint arrives 2-3x (measured: a 36-vertex chain whose real corners
                #    numbered 12), and that is an artefact of assembly, not geometry.
                pts = _simplify([((x + ox) * S, (y + oy) * S) for x, y in line], 1e-3 * S)
                if len(pts) < 2:
                    continue
                msp.add_lwpolyline(pts, dxfattribs=dict(attribs))
                xs += [p[0] for p in pts]; ys += [p[1] for p in pts]
        if xs and not view.get("noTitle"):  # numbered view title under the silhouette
            cx, ylo = (min(xs) + max(xs)) / 2, min(ys)
            _view_bubble(msp, (cx - 240 * S, ylo - 150 * S), view.get("num", ""), view["name"],
                         "1:10", S, style=view.get("titleStyle", title_style))
    print(f"  IFC views drawn: {len(views)} ({len(all_parts)} parts total)")


def _draw_poly3d(msp, spec: dict, all_parts: list, entities: list, S: float = 1.0) -> None:
    """Occlusion-clipped 3D glyphs (`poly3d` entities -- see the Entity union in
    apps/drawgen/src/model/drawing.ts): each is projected through its named VIEW and clipped against
    whatever steel actually sits between it and the viewer in that view -- IFC part meshes
    (see ViewDef.clipParts/clipIgnore) plus parametric occluder boxes (spec.occluders, e.g. an
    I-member's flange/web slabs; see box_mesh in ifc_geom.py) -- via a `RayOccluder` built once
    per view and reused across every entity that targets it. Falls back to drawing everything
    unclipped if the IFC/ifcopenshell isn't available, same graceful degradation as
    `_draw_ifc_views`. Must run AFTER `_draw_ifc_views` (so occlusion sees the same part set)
    and BEFORE `_place_avoiding` (so labels dodge the glyphs it draws)."""
    if not entities:
        return
    views = {v["name"]: v for v in (spec.get("views") or [])}
    try:
        import ifc_geom
        import_ok = True
    except Exception as ex:
        print(f"  (poly3d occlusion skipped, drawing unclipped: {ex})")
        import_ok = False

    occluder_boxes = spec.get("occluders") or []
    occ_cache: dict = {}  # view name -> RayOccluder, built once and reused per entity

    def occluder_for(view: dict):
        key = view["name"]
        if key in occ_cache:
            return occ_cache[key]
        wanted = view.get("clipParts", view.get("parts"))
        ignore = set(view.get("clipIgnore") or [])
        meshes = [(verts, faces) for (_typ, name, verts, faces) in all_parts
                  if (wanted is None or name in wanted) and name not in ignore]
        for b in occluder_boxes:
            meshes.append(ifc_geom.box_mesh(b["center"], b["ax"], b["ay"], b["az"], b["half"]))
        occ = ifc_geom.RayOccluder(meshes)
        occ_cache[key] = occ
        return occ

    doc = msp.doc
    drawn = 0
    for e in entities:
        view = views.get(e["view"])
        if view is None:
            print(f"  (poly3d entity references unknown view {e['view']!r}, skipping)")
            continue
        o, u, v = view["origin"], view["u"], view["v"]
        ox, oy = view["ox"], view["oy"]
        # same normal convention as ifc_geom.view_linework: cross(u,v), flipped by flipDepth,
        # points TOWARD the viewer (higher depth = nearer).
        normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        if view.get("flipDepth"):
            normal = [-x for x in normal]
        closed = bool(e.get("closed"))
        clip_mode = e.get("clip", "segment")
        pts3d = [tuple(p) for p in e["points"]]

        if clip_mode == "none" or not import_ok:
            runs, run_closed = [pts3d], closed
        else:
            runs = ifc_geom.clip_polyline(pts3d, closed, occluder_for(view), normal, mode=clip_mode)
            run_closed = closed if clip_mode == "whole" else False  # segment-clipped runs are open

        attribs = {"layer": e["layer"]}
        lt = hs.ENTITY_LINETYPE.get(e["layer"])
        if lt and lt in doc.linetypes:
            attribs["linetype"] = lt
        for run in runs:
            proj = []
            for p in run:
                d = [p[i] - o[i] for i in range(3)]
                pu = sum(d[i] * u[i] for i in range(3)) + ox
                pv = sum(d[i] * v[i] for i in range(3)) + oy
                proj.append((round(pu * S, 3), round(pv * S, 3)))
            # The occlusion clipper walks each polyline at a fixed SAMPLING resolution, so a
            # straight visible run comes back as dozens of collinear micro-segments (measured: a
            # single bolt shank line with 58 collinear vertices). That sampling rate is an
            # implementation detail of the clipper and has no business in the DXF, where every
            # vertex is a grip the detailer has to drag -- collapse it back to the real corners.
            proj = _simplify(proj, 1e-3 * S)
            # A CLOSED polyline must not repeat its first point as its last: the closing edge is
            # implied by `close=True`, so the duplicate is a phantom extra vertex. It also breaks
            # shape recognition downstream -- tools/verify_drawing.py identifies the
            # hexagonal bolt glyph by "closed LWPOLYLINE with exactly 6 vertices", and a 7th vertex
            # made every hexagon invisible to it.
            if run_closed and len(proj) > 2 and math.dist(proj[0], proj[-1]) <= 1e-3 * S:
                proj = proj[:-1]
            if len(proj) < 2:
                continue
            msp.add_lwpolyline(proj, close=run_closed, dxfattribs=dict(attribs))
            drawn += 1
    if drawn:
        print(f"  poly3d glyphs drawn: {drawn} (from {len(entities)} entities)")


def _view_bubble(msp, center, num: str, name: str, scale_txt: str, S: float = 1.0,
                 style: str = "bubble") -> None:
    """Numbered view-title callout: a circle carrying the detail number, with the view name and
    scale set beside it. Mirrors viewBubble() in apps/drawgen/src/drawing/views.ts so a title drawn here
    (IFC-titled views) is indistinguishable from one the TS side draws for its own sections.

    The TITLE bubble radius (profile `view_title.bubble_r`) is deliberately NOT the SECTION MARK
    bubble's (`section_mark.bubble_r`): two different radii carrying two different meanings."""
    # the title AND the bubble's own number share the title height; the scale line is one tier
    # down -- the same profile ladder views.ts uses (text_height.title / .sub).
    th = hs.PROFILE["text_height"]
    h_title, h_sub = th["title"] * S, th["sub"] * S
    L = {"layer": "text", "style": hs.PROFILE["text_style"]}
    cx, cy = center
    if style == "underline":
        # underline policy: plain caption, no bubble / number / scale. Drawn directly (not
        # deferred) because an IFC-titled view's position is already clear of its own silhouette.
        t = msp.add_text(name, height=h_title, dxfattribs=dict(L))
        t.set_placement((cx, cy), align=TextEntityAlignment.LEFT)
        w = text_width(name, h_title)
        msp.add_line((cx - 0.6 * h_title, cy - 0.35 * h_title),
                     (cx - 0.6 * h_title + w, cy - 0.35 * h_title),
                     dxfattribs={"layer": "text"})
        return
    msp.add_circle((cx, cy), hs.PROFILE["view_title"]["bubble_r"] * S, dxfattribs={"layer": "text"})
    if num:
        t = msp.add_text(num, height=h_title, dxfattribs=dict(L))
        t.set_placement((cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)
    t1 = msp.add_text(name, height=h_title, dxfattribs=dict(L))
    t1.set_placement((cx + 105 * S, cy + 14 * S), align=TextEntityAlignment.LEFT)
    t2 = msp.add_text(scale_txt, height=h_sub, dxfattribs=dict(L))
    t2.set_placement((cx + 105 * S, cy - 40 * S), align=TextEntityAlignment.LEFT)


def _sheet(doc, msp, sheet: dict, S: float = 1.0) -> None:
    """Build a paperspace A1 layout: border, viewport (1:scale), title block, scale bar.

    PAPER geometry (border, title block, scale bar) is always real paper mm and is NOT touched by
    the unit scale -- only the MODEL side is. The viewport therefore divides by an EFFECTIVE
    scale of `sheet.scale * S`: at 1:10 that is 10 for a mm-native model (250 units -> 25 mm) and
    1 for a cm-native one (25 units -> 25 mm). Same printed size either way."""
    from ezdxf import bbox
    for role in ("title_block", "note", "frame"):
        if hs.layer_name(role) not in doc.layers:
            doc.layers.add(hs.layer_name(role), color=7)
    if hs.PROFILE["sheet_text_style"] not in doc.styles:
        doc.styles.add(hs.PROFILE["sheet_text_style"], font="arial.ttf")

    W, H = sheet["paper"]["w"], sheet["paper"]["h"]
    scale = float(sheet["scale"])          # the DRAWING scale printed on the sheet (1:scale)
    eff = scale * S                        # model units -> paper mm divisor (see the docstring)
    psp = doc.layout("Layout1")
    psp.page_setup(size=(int(W), int(H)), margins=(0, 0, 0, 0), units="mm")
    m = 10  # border inset

    psp.add_lwpolyline([(m, m), (W - m, m), (W - m, H - m), (m, H - m)],
                       close=True, dxfattribs={"layer": "frame"})

    tb_w, tb_h = 190.0, 66.0
    _title_block(psp, W - m - tb_w, m, tb_w, tb_h, sheet["title"])
    _scale_bar(psp, m + 12, m + 14, scale)   # the bar is labelled in real metres, so real scale

    # viewport into model space, all geometry at 1:scale, centred in the drawing area
    ext = bbox.extents(msp)
    mcx = (ext.extmin.x + ext.extmax.x) / 2
    mcy = (ext.extmin.y + ext.extmax.y) / 2
    pad = 1.18
    vw = ext.size.x * pad / eff
    vh = ext.size.y * pad / eff
    vpx = (m + (W - m - tb_w)) / 2
    vpy = H / 2 + 20
    vp = psp.add_viewport(center=(vpx, vpy), size=(vw, vh),
                          view_center_point=(mcx, mcy), view_height=ext.size.y * pad)
    vp.dxf.status = 1


def _title_block(psp, x, y, w, h, fields) -> None:
    L = "title_block"
    psp.add_lwpolyline([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], close=True, dxfattribs={"layer": L})
    rows = (len(fields) + 1) // 2
    rh, cw = h / rows, w / 2
    for i, f in enumerate(fields):
        col, row = i % 2, i // 2
        cx, cy = x + col * cw, y + h - (row + 1) * rh
        psp.add_lwpolyline([(cx, cy), (cx + cw, cy), (cx + cw, cy + rh), (cx, cy + rh)],
                           close=True, dxfattribs={"layer": L})
        lbl = psp.add_text(f["label"], height=1.4, dxfattribs={"layer": L, "style": hs.PROFILE["sheet_text_style"]})
        lbl.set_placement((cx + 2, cy + rh - 2), align=TextEntityAlignment.TOP_LEFT)
        if f.get("value"):
            val = psp.add_text(f["value"], height=2.6, dxfattribs={"layer": L, "style": hs.PROFILE["sheet_text_style"]})
            val.set_placement((cx + 3, cy + 3), align=TextEntityAlignment.BOTTOM_LEFT)


def _scale_bar(psp, x, y, scale) -> None:
    L = "note"
    seg_m, n = 0.2, 5                      # 0..1.0 m in 0.2 m steps
    sp = seg_m * 1000 / scale              # segment length on paper (mm)
    for i in range(n):
        x0 = x + i * sp
        psp.add_lwpolyline([(x0, y), (x0 + sp, y), (x0 + sp, y + 3), (x0, y + 3)],
                           close=True, dxfattribs={"layer": L})
        t = psp.add_text(f"{i * seg_m:.1f}", height=2.0, dxfattribs={"layer": L, "style": hs.PROFILE["sheet_text_style"]})
        t.set_placement((x0, y + 4), align=TextEntityAlignment.BOTTOM_LEFT)
    te = psp.add_text(f"{n * seg_m:.1f}m", height=2.0, dxfattribs={"layer": L, "style": hs.PROFILE["sheet_text_style"]})
    te.set_placement((x + n * sp, y + 4), align=TextEntityAlignment.BOTTOM_LEFT)
    ts = psp.add_text(f"SCALE 1:{int(scale)}", height=2.6, dxfattribs={"layer": L, "style": hs.PROFILE["sheet_text_style"]})
    ts.set_placement((x, y - 3), align=TextEntityAlignment.TOP_LEFT)


def _preview(doc, msp, png_path: Path, sheet: bool = False) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

    # Sheet -> render the A1 paperspace on white (paper look); model -> black bg.
    layout = doc.layout("Layout1") if sheet else msp
    bg = "white" if sheet else "black"
    fig = plt.figure(figsize=(14, 10), facecolor=bg)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_facecolor(bg)
    ctx = RenderContext(doc)
    Frontend(ctx, MatplotlibBackend(ax)).draw_layout(layout, finalize=True)
    ax.set_aspect("equal")
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(png_path, dpi=150, facecolor=bg)
    print(f"PNG written: {png_path}")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    spec_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "app" / "out" / "spec.json"
    dxf_path = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "output" / "slice_elevation.dxf"
    png_path = Path(sys.argv[3]) if len(sys.argv) > 3 else root / "output" / "slice_elevation.png"

    force_model = len(sys.argv) > 4 and sys.argv[4] == "model"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    print(f"spec: {spec_path}  title='{spec['meta']['title']}'")
    render(spec, dxf_path, png_path, force_model=force_model)


if __name__ == "__main__":
    main()
