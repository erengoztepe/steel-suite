"""Physical IFC model(s) -> ONE structural-analysis IFC that SAP2000 imports as frames.

Backend of the "Null Facade" tab's "Export structure IFC" button: the viewer posts every
loaded IFC, this writes an IfcStructuralAnalysisModel built from their linear elements
(IfcBeam / IfcColumn / IfcMember):

  * one IfcStructuralCurveMember per bar, through the section CENTROID (the extrusion
    axis of the body, not the Axis representation, which may sit on a cardinal point);
    section = the element's own IfcProfileDef, material = the chosen steel grade;
  * IfcStructuralPointConnections shared by the members that meet there: ends closer
    than ``merge_tol`` become one node; an end within ``connect_tol`` of another bar is
    snapped onto it and that bar is split there, so SAP gets a connected frame;
  * supports on the lowest nodes (optional).

The layout is the one SAP2000 27 imported cleanly (1642 members, 632 joints) from the
sample gridshell; the file holds the analysis model only, so SAP's IFC import has no
physical duplicates to skip.

    python tools/sap/ifc_to_structure.py out.ifc a.ifc [b.ifc ...] [--classes beam,column,member]
        [--merge-tol 10] [--connect-tol 50] [--split-crossings] [--supports pinned|fixed|none]
        [--support-tol 10] [--grade S355]

Prints one JSON object on stdout ({"error": ...} on failure).
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import ifcopenshell
import ifcopenshell.api as api
import ifcopenshell.util.placement as uplace
import ifcopenshell.util.unit as uunit

CLASSES = {"beam": "IfcBeam", "column": "IfcColumn", "member": "IfcMember"}

# EN 1993-1-1 Table 3.1 (t <= 40 mm); in the output units (N, mm, kg, m)
GRADES = {"S235": (235.0, 360.0), "S275": (275.0, 430.0), "S355": (355.0, 490.0),
          "S460": (460.0, 540.0)}


@dataclass
class Bar:
    name: str
    a: np.ndarray            # mm, world
    b: np.ndarray
    y: np.ndarray            # section depth direction (unit, world)
    profile: object | None   # IfcProfileDef from the source file
    profile_name: str
    source: str
    cls: str
    splits: list[np.ndarray] = field(default_factory=list)  # split points, mm


# ------------------------------------------------------------------ reading
def _a2p(placement):
    return uplace.get_axis2placement(placement) if placement else np.eye(4)


def _profile_frame(profile):
    """4x4 of the profile's own 2D placement, in the solid's local XY."""
    m = np.eye(4)
    pos = getattr(profile, "Position", None)
    if pos is not None:
        o = pos.Location.Coordinates
        rd = pos.RefDirection.DirectionRatios if pos.RefDirection else (1.0, 0.0)
        x = np.array([rd[0], rd[1], 0.0])
        x /= np.linalg.norm(x)
        m[:3, 0], m[:3, 1], m[:3, 3] = x, np.array([-x[1], x[0], 0.0]), [o[0], o[1], 0.0]
    if profile.is_a("IfcArbitraryClosedProfileDef"):
        # no parametric centroid: use the polygon's area centroid
        c = _polygon_centroid(profile.OuterCurve)
        if c is not None:
            m[:3, 3] += m[:3, 0] * c[0] + m[:3, 1] * c[1]
    return m


def _polygon_centroid(curve):
    if not curve.is_a("IfcPolyline"):
        return None
    p = np.array([pt.Coordinates[:2] for pt in curve.Points], dtype=float)
    x, y = p[:, 0], p[:, 1]
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cr = x * y1 - x1 * y
    a = cr.sum() / 2
    if abs(a) < 1e-12:
        return None
    return np.array([((x + x1) * cr).sum() / (6 * a), ((y + y1) * cr).sum() / (6 * a)])


def _extrusion(item, m):
    """Find the IfcExtrudedAreaSolid under a body item; returns (solid, 4x4) or None."""
    if item.is_a("IfcExtrudedAreaSolid"):
        return item, m
    if item.is_a("IfcBooleanResult"):  # incl. IfcBooleanClippingResult: keep the base solid
        return _extrusion(item.FirstOperand, m)
    if item.is_a("IfcMappedItem"):
        mm = m @ uplace.get_mappeditem_transformation(item)
        for sub in item.MappingSource.MappedRepresentation.Items:
            hit = _extrusion(sub, mm)
            if hit:
                return hit
    return None


def _axis_from_body(element, scale):
    rep = element.Representation
    if not rep:
        return None
    m_obj = uplace.get_local_placement(element.ObjectPlacement) if element.ObjectPlacement else np.eye(4)
    for r in rep.Representations:
        if r.RepresentationIdentifier != "Body":
            continue
        for item in r.Items:
            hit = _extrusion(item, m_obj)
            if not hit:
                continue
            solid, m = hit
            m = m @ _a2p(solid.Position) @ _profile_frame(solid.SweptArea)
            d = np.array(solid.ExtrudedDirection.DirectionRatios, dtype=float)
            d /= np.linalg.norm(d)
            # the profile frame does not rotate the extrusion direction: undo it
            pf = _profile_frame(solid.SweptArea)
            d_local = np.linalg.inv(pf[:3, :3]) @ d
            a = (m @ np.array([0, 0, 0, 1.0]))[:3]
            b = (m @ np.append(d_local * solid.Depth, 1.0))[:3]
            y = m[:3, 1] / np.linalg.norm(m[:3, 1])
            return a * scale, b * scale, y, solid.SweptArea
    return None


def _axis_from_mesh(element, settings, scale):
    import ifcopenshell.geom
    try:
        shape = ifcopenshell.geom.create_shape(settings, element)
    except Exception:
        return None
    v = np.array(shape.geometry.verts, dtype=float).reshape(-1, 3)
    if len(v) < 4:
        return None
    c = v.mean(0)
    _, _, vt = np.linalg.svd(v - c, full_matrices=False)
    d, y = vt[0], vt[1]
    t = (v - c) @ d
    # the centreline runs through the middle of the cross-section's extent
    u1, u2 = (v - c) @ vt[1], (v - c) @ vt[2]
    mid = c + vt[1] * (u1.max() + u1.min()) / 2 + vt[2] * (u2.max() + u2.min()) / 2
    return (mid + d * t.min()) * scale, (mid + d * t.max()) * scale, y, None


def read_bars(paths, classes, warnings):
    import ifcopenshell.geom
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    bars, seen, stats = [], set(), Counter()
    bboxes = {}
    for path in paths:
        f = ifcopenshell.open(str(path))
        scale = uunit.calculate_unit_scale(f) * 1000.0      # file length unit -> mm
        name = Path(path).name
        pts = []
        for cls in classes:
            for e in f.by_type(cls):
                if e.GlobalId in seen:
                    stats["duplicate"] += 1
                    continue
                seen.add(e.GlobalId)
                axis = _axis_from_body(e, scale)
                if axis:
                    stats["body"] += 1
                else:
                    axis = _axis_from_mesh(e, settings, 1000.0)   # geom output is in metres
                    if not axis:
                        stats["no_geometry"] += 1
                        continue
                    stats["mesh"] += 1
                a, b, y, prof = axis
                if np.linalg.norm(b - a) < 1.0:
                    stats["zero_length"] += 1
                    continue
                pname = _section_name(e, prof) or cls
                label = e.Tag or e.Name or e.GlobalId
                bars.append(Bar(str(label), a, b, y, prof, str(pname), name, cls))
                pts += [a, b]
        if pts:
            p = np.array(pts)
            bboxes[name] = (p.min(0), p.max(0))
    _check_frames(bboxes, warnings)
    return bars, stats


def _section_name(element, profile):
    """Profile name, else the type name. Revit writes "Family:Type[:Id]": keep the
    last part that is not a bare element id (-> "UC305x305x97")."""
    import ifcopenshell.util.element as uel
    name = getattr(profile, "ProfileName", None) if profile else None
    if name:
        return name
    t = uel.get_type(element)
    for cand in (t.Name if t else None, element.ObjectType, element.Name):
        if cand:
            parts = [p.strip() for p in str(cand).split(":") if p.strip()]
            while len(parts) > 1 and parts[-1].isdigit():
                parts.pop()
            return parts[-1] if parts else None
    return None


def _check_frames(bboxes, warnings):
    """Files exported from different origins land far apart: say so, don't fix it."""
    items = list(bboxes.items())
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            (na, (lo1, hi1)), (nb, (lo2, hi2)) = items[i], items[j]
            gap = np.maximum(0, np.maximum(lo1 - hi2, lo2 - hi1))
            size = max(np.linalg.norm(hi1 - lo1), np.linalg.norm(hi2 - lo2), 1.0)
            if np.linalg.norm(gap) > size:
                warnings.append(f"{na} and {nb} are {np.linalg.norm(gap) / 1000:.1f} m apart - "
                                "different world origins? Members of the two files will not connect.")


# ------------------------------------------------------------------ topology
def _closest_on_segment(p, a, b):
    ab = b - a
    t = float(np.clip((p - a) @ ab / (ab @ ab), 0.0, 1.0))
    return t, a + t * ab


def _segment_crossing(a, b, c, d):
    u, v, w = b - a, d - c, a - c
    uu, uv, vv, uw, vw = u @ u, u @ v, v @ v, u @ w, v @ w
    den = uu * vv - uv * uv
    if den < 1e-9 * uu * vv:
        return None
    s, t = (uv * vw - vv * uw) / den, (uu * vw - uv * uw) / den
    return s, t, np.linalg.norm((a + s * u) - (c + t * v))


def connect(bars, merge_tol, connect_tol, split_crossings, stats):
    """Snap loose ends onto nearby bars (splitting those) and optionally split X crossings.

    Every query runs against the ORIGINAL geometry and the snaps are applied afterwards,
    so the result does not depend on bar order (and two bars cannot drag each other's
    ends around). Splits are stored as points, not parameters: the node a snapped end
    lands on stays exactly where that end is, even if the split bar's own ends move."""
    if not bars:
        return
    A0 = np.array([b.a for b in bars])
    B0 = np.array([b.b for b in bars])
    ends = np.vstack([A0, B0])                     # end k of bar i: k = i (a) or i + n (b)
    n = len(bars)
    lo = np.minimum(A0, B0) - connect_tol
    hi = np.maximum(A0, B0) + connect_tol
    moves = []
    for i in range(n):
        for which, p in (("a", A0[i]), ("b", B0[i])):
            near = np.linalg.norm(ends - p, axis=1)
            near[[i, i + n]] = np.inf
            if near.min() <= merge_tol:
                continue                           # already meets another end
            best = None
            for j in np.flatnonzero(np.all((p >= lo) & (p <= hi), axis=1)):
                if j == i:
                    continue
                L = np.linalg.norm(B0[j] - A0[j])
                t, q = _closest_on_segment(p, A0[j], B0[j])
                dist = np.linalg.norm(q - p)
                if dist > connect_tol or (best and dist >= best[0]):
                    continue
                if t * L <= merge_tol:
                    q, t = A0[j], 0.0
                elif (1 - t) * L <= merge_tol:
                    q, t = B0[j], 1.0
                best = (dist, j, t, q.copy())
            if best:
                moves.append((i, which, *best))
    for i, which, dist, j, t, q in moves:
        bar = bars[i]
        other = bar.b if which == "a" else bar.a
        if np.linalg.norm(q - other) <= merge_tol:
            continue                               # would collapse the bar
        setattr(bar, which, q)
        if 0.0 < t < 1.0:
            bars[j].splits.append(q)
            stats["split_at_end"] += 1
        if dist > merge_tol:
            stats["snapped_ends"] += 1
    if split_crossings:
        for i in range(n):
            for j in range(i + 1, n):
                if np.any(lo[i] > hi[j]) or np.any(lo[j] > hi[i]):
                    continue
                r = _segment_crossing(A0[i], B0[i], A0[j], B0[j])
                if not r:
                    continue
                s_, t, gap = r
                Li, Lj = np.linalg.norm(B0[i] - A0[i]), np.linalg.norm(B0[j] - A0[j])
                if (gap <= merge_tol and merge_tol < s_ * Li < Li - merge_tol
                        and merge_tol < t * Lj < Lj - merge_tol):
                    x = (A0[i] + s_ * (B0[i] - A0[i]) + A0[j] + t * (B0[j] - A0[j])) / 2
                    bars[i].splits.append(x)
                    bars[j].splits.append(x)
                    stats["crossings_split"] += 1


def build_graph(bars, merge_tol):
    """Pieces between nodes; nodes clustered within merge_tol. -> (nodes, pieces)."""
    raw = []
    for bi, bar in enumerate(bars):
        ab = bar.b - bar.a
        inner = sorted(bar.splits, key=lambda q: float((q - bar.a) @ ab))
        pts = [bar.a, *inner, bar.b]
        for k in range(len(pts) - 1):
            raw.append((bi, k, len(pts) - 1, pts[k], pts[k + 1]))
    allp = np.array([p for r in raw for p in (r[3], r[4])])
    # cluster: grid hash + union-find
    parent = list(range(len(allp)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    cell = defaultdict(list)
    for i, p in enumerate(allp):
        cell[tuple(np.floor(p / max(merge_tol, 1e-6)).astype(int))].append(i)
    for key, idx in cell.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for j in cell.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                        for i in idx:
                            if i < j and np.linalg.norm(allp[i] - allp[j]) <= merge_tol:
                                parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(len(allp)):
        groups[find(i)].append(i)
    node_of, nodes = {}, []
    for root, idx in groups.items():
        node_of.update({i: len(nodes) for i in idx})
        nodes.append(allp[idx].mean(0))
    pieces, seen = [], set()
    for k, (bi, part, nparts, _, _) in enumerate(raw):
        na, nb = node_of[2 * k], node_of[2 * k + 1]
        if na == nb:
            continue
        key = (min(na, nb), max(na, nb), bars[bi].profile_name)
        if key in seen:                       # two elements on the same line: keep one
            continue
        seen.add(key)
        pieces.append((bi, part, nparts, na, nb))
    return nodes, pieces


# ------------------------------------------------------------------ writing
def _copy_entity(f, inst, memo=None):
    """Copy an entity (and what it references) into ``f``; works across schemas
    (IFC2X3 profile -> IFC4 file) by matching attribute names."""
    memo = {} if memo is None else memo
    if inst.id() in memo:
        return memo[inst.id()]
    if f.schema == inst.wrapped_data.is_a(True).split(".")[0].upper():
        memo[inst.id()] = f.add(inst)
        return memo[inst.id()]

    def conv(v):
        if isinstance(v, ifcopenshell.entity_instance):
            return _copy_entity(f, v, memo) if v.id() else f.create_entity(v.is_a(), v.wrappedValue)
        if isinstance(v, (tuple, list)):
            return [conv(x) for x in v]
        return v
    try:
        new = f.create_entity(inst.is_a())
    except Exception:
        return None
    names = {a.name() for a in new.wrapped_data.declaration().as_entity().all_attributes()}
    for k, v in inst.get_info(recursive=False, include_identifier=False).items():
        if k in names and k != "type" and v is not None:
            setattr(new, k, conv(v))
    memo[inst.id()] = new
    return new


def write_ifc(out, bars, nodes, pieces, supports, support_nodes, grade, title):
    f = api.run("project.create_file", version="IFC4")
    project = api.run("root.create_entity", f, ifc_class="IfcProject", name=title)
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "MILLIMETERS"})
    model_ctx = api.run("context.add_context", f, context_type="Model")
    ref = api.run("context.add_context", f, context_type="Model", context_identifier="Reference",
                  target_view="GRAPH_VIEW", parent=model_ctx)
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = api.run("root.create_entity", f, ifc_class="IfcBuilding", name=title)
    api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    api.run("aggregate.assign_object", f, relating_object=site, products=[building])

    mm = next(u for u in f.by_type("IfcSIUnit") if u.UnitType == "LENGTHUNIT")
    si = lambda t, n, pre=None: f.create_entity("IfcSIUnit", UnitType=t, Prefix=pre, Name=n)
    newton, kg, metre = si("FORCEUNIT", "NEWTON"), si("MASSUNIT", "GRAM", "KILO"), si("LENGTHUNIT", "METRE")
    derived = lambda t, *els: f.create_entity("IfcDerivedUnit", Elements=[
        f.create_entity("IfcDerivedUnitElement", Unit=u, Exponent=e) for u, e in els], UnitType=t)
    units = f.by_type("IfcUnitAssignment")[0]
    units.Units = list(units.Units) + [newton, kg, si("PRESSUREUNIT", "PASCAL", "MEGA"),
                                       derived("MODULUSOFELASTICITYUNIT", (newton, 1), (mm, -2)),
                                       derived("MASSDENSITYUNIT", (kg, 1), (metre, -3))]
    steel = api.run("material.add_material", f, name=grade, category="steel")
    fy, fu = GRADES[grade]
    for pname, props in {
        "Pset_MaterialCommon": {"MassDensity": 7850.0},
        "Pset_MaterialMechanical": {"YoungModulus": 210000.0, "ShearModulus": 81000.0, "PoissonRatio": 0.3},
        "Pset_MaterialSteel": {"YieldStress": fy, "UltimateStress": fu},
    }.items():
        api.run("pset.edit_pset", f, pset=api.run("pset.add_pset", f, product=steel, name=pname),
                properties=props)

    am = api.run("structural.add_structural_analysis_model", f)
    origin = f.createIfcLocalPlacement(None, f.createIfcAxis2Placement3D(
        f.createIfcCartesianPoint([0.0, 0.0, 0.0]), None, None))
    am.Name, am.PredefinedType, am.SharedPlacement = title, "LOADING_3D", origin
    api.run("structural.assign_to_building", f, structural_analysis_model=am, building=building)
    flag = lambda v: f.create_entity("IfcBoolean", v)
    cond = None
    if supports != "none":
        rot = supports == "fixed"
        cond = f.create_entity("IfcBoundaryNodeCondition", Name=supports.capitalize(),
                               TranslationalStiffnessX=flag(True), TranslationalStiffnessY=flag(True),
                               TranslationalStiffnessZ=flag(True), RotationalStiffnessX=flag(rot),
                               RotationalStiffnessY=flag(rot), RotationalStiffnessZ=flag(rot))
    topo = lambda kind, item: f.createIfcProductDefinitionShape(None, None, [
        f.createIfcTopologyRepresentation(ref, "Reference", kind, [item])])

    items, verts, n_sup = [], [], 0
    for i, p in enumerate(nodes):
        v = f.createIfcVertexPoint(f.createIfcCartesianPoint([float(c) for c in p]))
        pc = api.run("root.create_entity", f, ifc_class="IfcStructuralPointConnection", name=f"N{i + 1}")
        pc.ObjectPlacement, pc.Representation = origin, topo("Vertex", v)
        if cond and i in support_nodes:
            pc.AppliedCondition = cond
            n_sup += 1
        verts.append((pc, v))
        items.append(pc)

    by_profile, profiles = defaultdict(list), {}
    for bi, part, nparts, na, nb in pieces:
        bar = bars[bi]
        name = bar.name if nparts == 1 else f"{bar.name}-{part + 1}"
        m = api.run("root.create_entity", f, ifc_class="IfcStructuralCurveMember", name=name,
                    predefined_type="RIGID_JOINED_MEMBER")
        d = bar.b - bar.a
        d /= np.linalg.norm(d)
        y = bar.y - (bar.y @ d) * d
        y = y / np.linalg.norm(y) if np.linalg.norm(y) > 1e-9 else np.cross(d, [1.0, 0, 0])
        m.Description, m.ObjectPlacement = bar.profile_name, origin
        m.Axis = f.createIfcDirection([float(c) for c in y])
        m.Representation = topo("Edge", f.createIfcEdge(verts[na][1], verts[nb][1]))
        for pc in (verts[na][0], verts[nb][0]):
            api.run("structural.add_structural_member_connection", f, relating_structural_member=m,
                    related_structural_connection=pc)
        by_profile[bar.profile_name].append(m)
        if bar.profile_name not in profiles and bar.profile is not None:
            profiles[bar.profile_name] = bar.profile
        items.append(m)
    missing = []
    for pname, members in by_profile.items():
        pset = api.run("material.add_material_set", f, name=pname, set_type="IfcMaterialProfileSet")
        src = profiles.get(pname)
        prof = _copy_entity(f, src) if src is not None else None
        if prof is None:
            missing.append(pname)
        api.run("material.add_profile", f, profile_set=pset, material=steel, profile=prof)
        api.run("material.assign_material", f, products=members, type="IfcMaterialProfileSetUsage",
                material=pset)
    for usage in f.by_type("IfcMaterialProfileSetUsage"):
        usage.CardinalPoint = 5
    api.run("structural.assign_structural_analysis_model", f, products=items, structural_analysis_model=am)
    f.write(str(out))
    return n_sup, len(by_profile), missing


def pick_supports(bars, nodes, pieces, deg, where, tol):
    if where == "lowest":
        zmin = min(p[2] for p in nodes)
        return {i for i, p in enumerate(nodes) if p[2] <= zmin + tol}
    out = set()
    for bi, part, nparts, na, nb in pieces:
        if bars[bi].cls != "IfcColumn":
            continue
        low = na if nodes[na][2] <= nodes[nb][2] else nb
        is_end = (part == 0 and low == na) or (part == nparts - 1 and low == nb) or nparts == 1
        if is_end and deg[low] == 1:
            out.add(low)
    return out


def run(args):
    classes = [CLASSES[c] for c in args.classes.split(",") if c]
    if not classes:
        raise ValueError("pick at least one element class")
    warnings = []
    bars, stats = read_bars(args.inputs, classes, warnings)
    if not bars:
        raise ValueError("no beams / columns / members with usable geometry in the model(s)")
    connect(bars, args.merge_tol, args.connect_tol, args.split_crossings, stats)
    nodes, pieces = build_graph(bars, args.merge_tol)
    title = args.title or Path(args.inputs[0]).stem
    deg = Counter()
    for _, _, _, na, nb in pieces:
        deg[na] += 1
        deg[nb] += 1
    support_nodes = pick_supports(bars, nodes, pieces, deg, args.support_at, args.support_tol)
    n_sup, n_sec, missing = write_ifc(args.output, bars, nodes, pieces, args.supports,
                                      support_nodes, args.grade, title)
    if stats["mesh"]:
        warnings.append(f"{stats['mesh']} elements had no extruded body: axis fitted to the mesh "
                        "(curved members come out straight).")
    if missing:
        warnings.append("No profile geometry for: " + ", ".join(missing[:8]) +
                        " - SAP2000 will ask for these sections.")
    return {
        "files": len(args.inputs),
        "elements": len(bars),
        "members": len(pieces),
        "nodes": len(nodes),
        "supports": n_sup,
        "sections": n_sec,
        "freeEnds": sum(1 for n in range(len(nodes)) if deg[n] == 1),
        "snappedEnds": stats["snapped_ends"],
        "splits": stats["split_at_end"] + stats["crossings_split"],
        "duplicates": stats["duplicate"],
        "skipped": stats["no_geometry"] + stats["zero_length"],
        "warnings": warnings,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("output")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--classes", default="beam,column,member")
    ap.add_argument("--merge-tol", type=float, default=10.0, help="mm")
    ap.add_argument("--connect-tol", type=float, default=300.0, help="mm")
    ap.add_argument("--split-crossings", action="store_true")
    ap.add_argument("--supports", choices=("pinned", "fixed", "none"), default="pinned")
    ap.add_argument("--support-at", choices=("lowest", "column-bases"), default="lowest",
                    help="lowest: nodes within --support-tol of the lowest node; column-bases: "
                         "the bottom end of every column that nothing else continues below")
    ap.add_argument("--support-tol", type=float, default=10.0, help="mm above the lowest node")
    ap.add_argument("--grade", choices=sorted(GRADES), default="S355")
    ap.add_argument("--title", default=None)
    args = ap.parse_args(argv)
    try:
        out = run(args)
    except Exception as e:  # reported to the web page
        out = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
