"""House CAD standard, loaded from a STYLE PROFILE (server/style_profiles/*.json).

The drawing code never names a layer, linetype or text style of any particular firm. It
works in ROLES -- `visible`, `visible_thin`, `cut`, `hidden`, `axis`, `limit`, `bolt`,
`hatch`, `text`, `dimension`, `title_block`, `note`, `frame` -- and the profile maps each role
to a real layer (name, ACI colour, layer linetype, lineweight, plot flag). Everything else that
makes up a house style lives in the profile too: the linetype table, the entity-level linetype
per role, text styles, the dimension terminator and dimstyle sizes, leader arrowheads, view
title / section mark sizes and the cut-steel hatch.

Profile resolution (first hit wins), shared with the TS side (apps/drawgen/src/model/style.ts):
  1. an explicit path (render.py passes the one recorded in the spec's meta.styleProfile)
  2. $STEEL_STYLE_PROFILE -- a path, or a profile name in server/style_profiles/
  3. server/style_profiles/local.json -- your own house style; git-ignored, never committed
  4. server/style_profiles/default.json -- the neutral ISO style shipped with the repo

Two conventions every profile follows, because the renderer depends on them:
  * Dashing lives on the ENTITY, not the layer: layers stay Continuous and `entity_linetype`
    gives the hidden/axis roles their pattern.
  * Linetype patterns are written in the profile VERBATIM and never rescaled -- the document's
    unit (render.py's `unit_scale`) decides the physical dash, not the table.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

PROFILE_DIR = Path(__file__).resolve().parent / "style_profiles"

# Populated by load(); module-level so existing `house_style.X` reads keep working.
PROFILE: dict = {}
PROFILE_PATH: Path | None = None
LAYERS: dict = {}           # layer name -> (aci, layer linetype, lineweight, plot)
ROLE_LAYER: dict = {}       # role -> layer name
LAYER_ROLE: dict = {}       # layer name -> role
LINETYPES: dict = {}        # name -> (pattern, description)
ENTITY_LINETYPE: dict = {}  # role -> entity-level linetype
DIM_TICK_BLOCK = ""
DIM_TICK_RUN = 0.0
DIM_TICK_RISE = 0.0


def resolve_profile(explicit: str | os.PathLike | None = None) -> Path:
    def by_name_or_path(v: str) -> Path:
        p = Path(v)
        if p.suffix.lower() != ".json":
            p = PROFILE_DIR / f"{v}.json"
        elif not p.is_absolute() and not p.exists():
            p = PROFILE_DIR / p.name
        return p

    if explicit:
        p = by_name_or_path(str(explicit))
        if p.exists():
            return p
    env = os.environ.get("STEEL_STYLE_PROFILE")
    if env:
        p = by_name_or_path(env)
        if not p.exists():
            raise FileNotFoundError(f"STEEL_STYLE_PROFILE={env!r}: no such profile ({p})")
        return p
    local = PROFILE_DIR / "local.json"
    return local if local.exists() else PROFILE_DIR / "default.json"


def load(explicit: str | os.PathLike | None = None) -> dict:
    """(Re)load the active profile and refresh the module-level tables."""
    global PROFILE, PROFILE_PATH, DIM_TICK_BLOCK, DIM_TICK_RUN, DIM_TICK_RISE
    path = resolve_profile(explicit)
    prof = json.loads(path.read_text(encoding="utf-8"))
    PROFILE, PROFILE_PATH = prof, path
    LAYERS.clear(); ROLE_LAYER.clear(); LAYER_ROLE.clear()
    for lay in prof["layers"]:
        LAYERS[lay["name"]] = (int(lay["color"]), lay.get("linetype", "Continuous"),
                               int(lay.get("lineweight", -3)), int(lay.get("plot", 1)))
        if lay.get("role"):
            ROLE_LAYER[lay["role"]] = lay["name"]
            LAYER_ROLE[lay["name"]] = lay["role"]
    LINETYPES.clear()
    for name, lt in prof.get("linetypes", {}).items():
        LINETYPES[name] = (list(lt["pattern"]), lt.get("description", ""))
    ENTITY_LINETYPE.clear()
    ENTITY_LINETYPE.update(prof.get("entity_linetype", {}))
    dim = prof["dimension"]
    DIM_TICK_BLOCK = dim["tick_block"]
    DIM_TICK_RUN = float(dim["tick_run"])
    DIM_TICK_RISE = float(dim["tick_rise"])
    return prof


def layer_name(role: str) -> str:
    """Real layer name for a role (a name that is not a role passes through unchanged)."""
    return ROLE_LAYER.get(role, role)


def role_of(layer: str) -> str:
    """Role of a real layer name (inverse of layer_name; unknown names pass through)."""
    return LAYER_ROLE.get(layer, layer)


def text_style() -> dict:
    """The main annotation text style entry ({name, font, width})."""
    name = PROFILE["text_style"]
    return next(s for s in PROFILE["text_styles"] if s["name"] == name)


def make_dim_tick_block(doc) -> str:
    """Define the house dimension terminator as an arrow BLOCK and return its name.

    An AutoCAD arrow block is authored in DIMASZ-normalised units: it is inserted at the
    dimension line's end point and uniformly scaled by DIMASZ. So a unit-run block at the
    profile's run:rise slope, combined with DIMASZ = the tick's along-the-line length, yields
    the tick at ANY unit scale -- and the caller only has to scale DIMASZ, not the block.
    The line straddles the insertion point (-0.5..+0.5) so the tick is CENTRED on the
    extension line, not started at it.
    """
    if DIM_TICK_BLOCK not in doc.blocks:
        blk = doc.blocks.new(name=DIM_TICK_BLOCK)
        half_rise = 0.5 * (DIM_TICK_RISE / DIM_TICK_RUN)
        blk.add_line((-0.5, -half_rise), (0.5, half_rise))
    return DIM_TICK_BLOCK


def apply_house_style(doc) -> None:
    for name, (pattern, desc) in LINETYPES.items():
        if name in doc.linetypes:
            continue
        try:
            doc.linetypes.add(name, pattern=pattern, description=desc)
        except Exception:
            pass  # some CAD names (e.g. with spaces) may be rejected; best-effort
    make_dim_tick_block(doc)
    for name, (color, lt, lw, plot) in LAYERS.items():
        if name in doc.layers:
            layer = doc.layers.get(name)
        else:
            lt_ok = lt if lt in doc.linetypes else "Continuous"
            layer = doc.layers.add(name, color=color, linetype=lt_ok, lineweight=lw)
        try:
            layer.dxf.plot = plot
        except Exception:
            pass
    for st in PROFILE.get("text_styles", []):
        if st["name"] not in doc.styles:
            style = doc.styles.add(st["name"], font=st["font"])
            if float(st.get("width", 1.0)) != 1.0:
                style.dxf.width = float(st["width"])


def rename_role_layers(doc) -> None:
    """Final pass: every entity drawn on a ROLE gets the profile's real layer name.

    The renderer draws on role names throughout (so its own occlusion/overlap passes can query
    by role); this is the single place roles become the profile's real layer names.
    """
    layouts = [doc.modelspace()] + [doc.layout(n) for n in doc.layout_names() if n != "Model"]
    containers = list(layouts) + [b for b in doc.blocks if not b.name.lower().startswith("*model")]
    seen = set()
    for c in containers:
        for e in c:
            if id(e) in seen or not e.dxf.hasattr("layer"):
                continue
            seen.add(id(e))
            real = ROLE_LAYER.get(e.dxf.layer)
            if real:
                e.dxf.layer = real


load()
