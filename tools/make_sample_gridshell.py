"""Generate a SYNTHETIC steel diagrid gridshell to try the viewer / Member Vectors on.

    python tools/make_sample_gridshell.py [out.ifc]

Writes apps/viewer/public/models/sample_gridshell.ifc by default, and next to it <out>_sap.ifc:
the same file plus the bars as a structural analysis model for SAP2000 / ETABS (add_analysis).
Everything is made up from catalogue shapes -- no real project is involved.

  * Shell: half of a TRIAXIAL ellipsoid, footprint 40 m x 35 m (a = 20, b = 17.5), 20 m high
    (c = 20), standing directly on its ground nodes (the supports): nothing lies in the ground
    plane, no ring beam. Column-free inside.
  * DIAGRID: nodes on horizontal elliptical rings (M_BASE per ring, equally spaced by ARC
    LENGTH; all rings are scaled copies of the base ellipse, so a node keeps its parameter
    from ring to ring). Every ring is shifted half a step against the one below. The ring
    spacing balances the bar angles around 45 degrees between the flat ends and the steeper
    sides of the shell. The grid runs from the ground up to the TOP GRID ring; above it the
    shell is OPEN up to the CROWN ring, which rings an open (elliptical) oculus.
  * TOP GRID RING TRUSS: top chord on the shell, bottom chord depth_at() inside, posts +
    Warren diagonals. The girders and ribs interrupt it and carry its chords across on their
    own struts.
  * CROWN RING GIRDER around the oculus: a trapezoidal FOUR-chord ring like the girders -- the
    inner top chord rings the oculus (CROWN_K), the outer one runs CROWN_OUTER_K, the bottom
    chords inside -- so it takes bending both ways and torsion (the ribs end on its outer face,
    eccentrically). The main girders run through it (their struts at its two stations carry its
    chords across); it runs on across the ribs. Warren with verticals, opposite faces in phase,
    the zigzag mirror-symmetric about each rib (one diagonal in the rib's band breaks it).
  * MAIN girders, X-shaped in plan (ARCH_PSI): four-chord lattice girders with a TRAPEZOIDAL
    section that run CONTINUOUSLY from the ground on one side, over the oculus, to the ground
    on the other side; the two girders cross in a box over the oculus.
    - two top chords on the shell along two neighbouring node columns, so up to the top grid
      ring they run through diagrid nodes and no bar crosses them between nodes; above it
      they keep a constant width, through the crown ring and over the oculus;
    - two bottom chords inside, closer together (BOTTOM_WIDTH_RATIO of the top width); over
      the oculus they follow an inner ellipsoid depth_at() below the shell, so the two
      girders' chords meet exactly;
    - no frame at the ground (the chord feet are supports). Over the oculus each girder runs
      OCULUS_PANELS equal panels from the crown ring to its CROSSINGS with the other girder,
      its chords straight in plan and opening up to BOX_WIDTH apart there: they meet the
      other girder's chords at shared nodes (4 on top, 4 below) and a post joins each bottom
      crossing to the top crossing above it. Between them is the
      central box: the chord pieces between the crossings (each also the last strut of the
      other girder), the four posts, a side-face diagonal in each of its four walls and one
      diagonal across the rhombus -- the same one on top and below.
  * DOORS: in the diagrid gaps on both sides of the ribs on the DOOR_AXIS plan axis (the
    narrow ends of the 40 m axis: 4 doors, mirror-symmetric like the rest): DOOR_BAYS x
    DOOR_RINGS of diagrid left out from the ground up, centred in the gap, framed by two jambs
    along the edge node columns and a lintel along the top ring.
  * RIBS: one more trapezoidal four-chord lattice girder in the middle of each gap between the
    main girders (on the plan axes), built like them from the ground up to the crown ring
    girder's outer face, where they end; lighter sections.
  * LATTICE RULE (girders, ribs, box): Warren WITH verticals in all four faces, and opposite
    faces IN PHASE everywhere (left = right side face, top = bottom face).
    - side faces: a post at every station, one diagonal per panel; the first one rises from
      the inner (bottom) chord's foot -- the panel shear goes into the inner support while the
      outer one takes the shell -- and they alternate from there;
    - top / bottom faces: a strut at every station (where a ring truss meets the girder the
      strut is that ring's chord), one diagonal per panel zigzagging from the START chord at
      the ground; top and bottom start on the same side. The start chord is the one nearer
      the x axis (main arms) or on the + side of the other axis (ribs, which sit on one), so
      the lattices are mirror images across both symmetry axes, like the shell;
    - with one diagonal per panel the side and top / bottom diagonals cannot all meet at the
      same nodes: they do at two diagonally opposite corners of the section, a panel apart at
      the other two -- the same everywhere;
    - panels: tied to the diagrid in its zone (every second ring); OPEN_PANELS equal ones in
      the open band, OCULUS_PANELS over the oculus; never below MIN_LATTICE_MEMBER;
    - depth: depth_at(), DEPTH_BASE at the ground -> DEPTH_TOP at the apex, linear in height:
      the chord feet are two pins a depth apart, so each girder is a FIXED-base arch whose
      moment, shear and thrust grow towards the springing.
  * Sections by ROLE (SECTIONS): girder / rib chords and every post between top and bottom
    chords are I-sections, the ring truss chords RHS; every brace (diagonals, face lattices,
    end frames) and the diagrid bars are CHS.

Every pair of members meeting at a node is at least 30 degrees apart and no member is longer
than MAX_MEMBER (tools/check_member_angles.py; tools/check_sample_gridshell.py). IFC4, millimetres, S355, one storey. Every
member carries a Body (swept solid along its centreline), an Axis and a unique Tag.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import ifcopenshell.api as api

OUT = Path(__file__).resolve().parent.parent / "apps/viewer/public/models/sample_gridshell.ifc"

A_X, B_Y, C_H = 20.0, 17.5, 20.0  # ellipsoid semi-axes: footprint 40 x 35 m, 20 m high
M_BASE = 40                      # diagrid nodes per ring (a multiple of 4: symmetric about both axes)
TOP_GRID_K = 0.67                # the diagrid stops at the last suitable ring above this scale
CROWN_K = 0.40                   # crown ring scale (its ellipse is the base ellipse x CROWN_K)
CROWN_OUTER_K = 0.50             # crown ring girder's outer top chord (~2.1 m outside the oculus edge)
DEPTH_BASE, DEPTH_TOP = 2.1, 1.9  # girder / ring truss depth along the shell normal: at the
                                  # ground / at the apex, linear in height (depth_at)
BOTTOM_WIDTH_RATIO = 0.88        # bottom-chord spacing / top-chord spacing (trapezoidal section)
GIRDER_SPLIT = 3.6               # girder panels between shared nodes longer than this get a mid node
RIB_AZ = (0.0, 90.0, 180.0, 270.0)  # ribs on the plan axes, one in each gap between the girders
SECTIONS = {                     # by role: chords + posts I (ring chords RHS), braces + diagrid CHS
    "main": {"chord": "HEB240", "post": "HEA160", "side": "CHS168.3x8", "lattice": "CHS168.3x8",
             "frame": "CHS168.3x8"},
    "rib": {"chord": "HEB200", "post": "HEA140", "side": "CHS139.7x8", "lattice": "CHS139.7x8",
            "frame": "CHS139.7x8"},
    "ring": {"chord": "RHS250x150x10", "post": "HEA140", "side": "CHS139.7x8", "lattice": "CHS139.7x8",
             "frame": "CHS139.7x8"},
    "diagrid": {"bar": "CHS193.7x8"},
    "door": {"frame": "RHS250x150x10"},
}
DOOR_BAYS, DOOR_RINGS = 2, 4     # door opening: diagrid bays wide x rings high (even), from the ground
DOOR_AXIS = "x"                  # doors on both sides of the ribs on this plan axis
OPEN_PANELS = 3                  # panels in the open band (top grid ring -> crown ring), girders and ribs
OCULUS_PANELS = 2                # main girder panels over the oculus: crown ring -> its crossings
BOX_WIDTH = 2.6                  # top-chord spacing at the crossings = size of the central box
CROWN_PANEL = 2.4                # crown ring truss panels between the girders
MAX_MEMBER = 6.0                 # no member longer than this (m)
MIN_LATTICE_MEMBER = 1.5         # no lattice (truss) member shorter than this (m)
RING_STEP_BIAS = 1.15            # >1 steepens the diagrid a little: the node meridians are skewed
                                 # against the rings on a triaxial ellipsoid, and the bars must stay
                                 # >= 30 deg off the ring trusses
UP = (0.0, 0.0, 1.0)
ARCH_PSI = math.radians(45.0)    # plan angle of the X
CATALOGUE = {                    # mm -- I: b, h, tw, tf, r; RHS: b, h, t; CHS: d, t
    "HEB240": ("I", 240.0, 240.0, 10.0, 17.0, 21.0), "HEB200": ("I", 200.0, 200.0, 9.0, 15.0, 18.0),
    "HEA160": ("I", 160.0, 152.0, 6.0, 9.0, 15.0), "HEA140": ("I", 140.0, 133.0, 5.5, 8.5, 12.0),
    "RHS250x150x10": ("RHS", 150.0, 250.0, 10.0),
    "CHS193.7x8": ("CHS", 193.7, 8.0), "CHS168.3x8": ("CHS", 168.3, 8.0), "CHS139.7x8": ("CHS", 139.7, 8.0),
}
S355 = {                         # EN 1993-1-1 values, in the analysis file's units (N, mm, kg, m)
    "Pset_MaterialCommon": {"MassDensity": 7850.0},                                   # kg/m3
    "Pset_MaterialMechanical": {"YoungModulus": 210000.0, "ShearModulus": 81000.0,   # N/mm2
                                "PoissonRatio": 0.3},
    "Pset_MaterialSteel": {"YieldStress": 355.0, "UltimateStress": 490.0},            # MPa
}


def profile_defs(f):
    """Profile lookup that creates each IfcProfileDef on first use: a file holds only what it uses."""
    pos2d = lambda: f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, 0.0]), None)
    make = {
        "I": lambda n, b, h, tw, tf, r: f.createIfcIShapeProfileDef("AREA", n, pos2d(), b, h, tw, tf, r),
        "RHS": lambda n, b, h, t: f.createIfcRectangleHollowProfileDef("AREA", n, pos2d(), b, h, t, 1.5 * t, t),
        "CHS": lambda n, d, t: f.createIfcCircleHollowProfileDef("AREA", n, pos2d(), d / 2, t),
    }
    made = {}

    def get(name):
        if name not in made:
            kind, *dims = CATALOGUE[name]
            made[name] = make[kind](name, *dims)
        return made[name]
    return get


def add_analysis(f, bars, elements, building, steel, profile_def, model_ctx):
    """Add the same bars as a STRUCTURAL ANALYSIS model, which SAP2000 / ETABS import as the
    'structural view' (File > Import > IFC -- pick that view only, or every bar comes in twice):
    one IfcStructuralCurveMember per bar (rigid-joined, section + S355 through an
    IfcMaterialProfileSetUsage, Axis = the section's depth direction) between
    IfcStructuralPointConnections that share its end vertices, pinned supports on the ground
    nodes. Each one is assigned to its physical element (IfcRelAssignsToProduct), which stays in
    the file, so a viewer still shows the solids (the analysis items have no body).
    bars: (profile, tag, a, b, depth_dir) in mm; elements: tag -> physical element.
    Returns (joints, supports)."""
    mm = next(u for u in f.by_type("IfcSIUnit") if u.UnitType == "LENGTHUNIT")
    si = lambda t, n, pre=None: f.create_entity("IfcSIUnit", UnitType=t, Prefix=pre, Name=n)
    newton, kg, metre = si("FORCEUNIT", "NEWTON"), si("MASSUNIT", "GRAM", "KILO"), si("LENGTHUNIT", "METRE")
    derived = lambda t, *els: f.create_entity("IfcDerivedUnit", Elements=[
        f.create_entity("IfcDerivedUnitElement", Unit=u, Exponent=e) for u, e in els], UnitType=t)
    units = f.by_type("IfcUnitAssignment")[0]
    units.Units = list(units.Units) + [newton, kg, si("PRESSUREUNIT", "PASCAL", "MEGA"),
                                       derived("MODULUSOFELASTICITYUNIT", (newton, 1), (mm, -2)),
                                       derived("MASSDENSITYUNIT", (kg, 1), (metre, -3))]
    ref = api.run("context.add_context", f, context_type="Model", context_identifier="Reference",
                  target_view="GRAPH_VIEW", parent=model_ctx)
    for name, props in S355.items():
        api.run("pset.edit_pset", f, pset=api.run("pset.add_pset", f, product=steel, name=name), properties=props)

    am = api.run("structural.add_structural_analysis_model", f)
    origin = f.createIfcLocalPlacement(None, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0]), None, None))
    am.Name, am.PredefinedType, am.SharedPlacement = "Gridshell", "LOADING_3D", origin
    api.run("structural.assign_to_building", f, structural_analysis_model=am, building=building)
    flag = lambda v: f.create_entity("IfcBoolean", v)
    pinned = f.create_entity("IfcBoundaryNodeCondition", Name="Pinned",
                             TranslationalStiffnessX=flag(True), TranslationalStiffnessY=flag(True),
                             TranslationalStiffnessZ=flag(True), RotationalStiffnessX=flag(False),
                             RotationalStiffnessY=flag(False), RotationalStiffnessZ=flag(False))
    topo = lambda kind, item: f.createIfcProductDefinitionShape(None, None, [
        f.createIfcTopologyRepresentation(ref, "Reference", kind, [item])])
    joints, items = {}, []

    def joint(p):
        k = tuple(round(c, 1) for c in p)
        if k not in joints:
            v = f.createIfcVertexPoint(f.createIfcCartesianPoint([float(c) for c in p]))
            pc = api.run("root.create_entity", f, ifc_class="IfcStructuralPointConnection", name=f"N{len(joints) + 1}")
            pc.ObjectPlacement, pc.Representation = origin, topo("Vertex", v)
            if abs(p[2]) < 1e-3:                               # on the ground: a support
                pc.AppliedCondition = pinned
            joints[k] = (pc, v)
            items.append(pc)
        return joints[k]

    by_profile = {}
    for profile, tag, a, b, y in bars:
        (pa, va), (pb, vb) = joint(a), joint(b)
        m = api.run("root.create_entity", f, ifc_class="IfcStructuralCurveMember", name=tag,
                    predefined_type="RIGID_JOINED_MEMBER")
        m.Description, m.ObjectPlacement, m.Axis = profile, origin, f.createIfcDirection([float(c) for c in y])
        m.Representation = topo("Edge", f.createIfcEdge(va, vb))
        for pc in (pa, pb):
            api.run("structural.add_structural_member_connection", f, relating_structural_member=m,
                    related_structural_connection=pc)
        api.run("structural.assign_product", f, relating_product=elements[tag], related_object=m)
        by_profile.setdefault(profile, []).append(m)
        items.append(m)
    for name, members in by_profile.items():
        pset = api.run("material.add_material_set", f, name=name, set_type="IfcMaterialProfileSet")
        api.run("material.add_profile", f, profile_set=pset, material=steel, profile=profile_def(name))
        api.run("material.assign_material", f, products=members, type="IfcMaterialProfileSetUsage", material=pset)
    for usage in f.by_type("IfcMaterialProfileSetUsage"):
        usage.CardinalPoint = 5                                 # the bar runs through the centroid
    api.run("structural.assign_structural_analysis_model", f, products=items, structural_analysis_model=am)
    return len(joints), sum(1 for pc, _ in joints.values() if pc.AppliedCondition)


# ------------------------------------------------------------------ geometry helpers
def surf(theta, phi):
    """Ellipsoid point; theta = 0 at the base ring, pi/2 at the apex; phi = ellipse parameter."""
    k = math.cos(theta)
    return (A_X * k * math.cos(phi), B_Y * k * math.sin(phi), C_H * math.sin(theta))


def normal(p):
    x, y, z = p
    n = (x / A_X ** 2, y / B_Y ** 2, z / C_H ** 2)
    m = math.sqrt(sum(c * c for c in n))
    return tuple(c / m for c in n)


def dsurf(theta, phi):
    """|dP/dtheta|: meridional speed at (theta, phi)."""
    return math.sqrt(math.sin(theta) ** 2 * (A_X ** 2 * math.cos(phi) ** 2 + B_Y ** 2 * math.sin(phi) ** 2)
                     + C_H ** 2 * math.cos(theta) ** 2)


def on_plane(z, e_par, e_lat, s):
    """Shell point at height z in the vertical plane {p . e_lat = s}, on the e_par side."""
    k2 = 1 - (z / C_H) ** 2
    ox, oy = s * e_lat[0], s * e_lat[1]
    qa = (e_par[0] / A_X) ** 2 + (e_par[1] / B_Y) ** 2
    qb = 2 * (ox * e_par[0] / A_X ** 2 + oy * e_par[1] / B_Y ** 2)
    qc = (ox / A_X) ** 2 + (oy / B_Y) ** 2 - k2
    u = (-qb + math.sqrt(max(0.0, qb * qb - 4 * qa * qc))) / (2 * qa)
    return (ox + u * e_par[0], oy + u * e_par[1], z)


def norm(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def sub(a, b):
    return tuple(a[i] - b[i] for i in range(3))


def add(a, b, s=1.0):
    return tuple(a[i] + s * b[i] for i in range(3))


def mid(a, b):
    return tuple((a[i] + b[i]) / 2 for i in range(3))


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def depth_at(z):
    return DEPTH_BASE + (DEPTH_TOP - DEPTH_BASE) * z / C_H


def inward(p):
    return add(p, normal(p), -depth_at(p[2]))


def plan_angle(p):
    return math.atan2(p[1], p[0])


def arc_params(n, offset):
    """n ellipse parameters equally spaced by arc length, shifted by `offset` steps."""
    import bisect
    N = 20000
    ph = [2 * math.pi * i / N for i in range(N + 1)]
    run = [0.0]
    for a, b in zip(ph, ph[1:]):
        run.append(run[-1] + math.dist((A_X * math.cos(a), B_Y * math.sin(a)), (A_X * math.cos(b), B_Y * math.sin(b))))
    total, out = run[-1], []
    for k in range(n):
        target = ((k + offset) % n) * total / n
        j = min(max(bisect.bisect_right(run, target) - 1, 0), N - 1)
        t = (target - run[j]) / (run[j + 1] - run[j])
        out.append(ph[j] + (ph[j + 1] - ph[j]) * t)
    return out, total


def build_rings():
    """Diagrid rings bottom-up as (theta, [phi]). Even rings sit on whole steps, odd rings half
    a step over them. The ring step balances the bar angle to the meridian around 45 deg: with
    rs = (meridional speed at the ends) / (at the sides), the side bars get atan(sqrt rs) and
    the end bars atan(1/sqrt rs). Ends at the last EVEN ring whose scale is >= TOP_GRID_K."""
    phi_even, perim = arc_params(M_BASE, 0.5)          # even rings: half a step off the axes
    phi_odd, _ = arc_params(M_BASE, 1.0)               # odd rings: on the axes
    rings, theta = [(0.0, phi_even)], 0.0
    while True:
        dtheta = 0.0
        for _ in range(4):
            m = theta + dtheta / 2
            half = perim * math.cos(m) / (2 * M_BASE)  # half-step arc on this ring
            rs = dsurf(m, 0.0) / dsurf(m, math.pi / 2)
            dtheta = RING_STEP_BIAS * half / (math.sqrt(rs) * dsurf(m, math.pi / 2))
        theta += dtheta
        if math.cos(theta) < TOP_GRID_K:
            break
        rings.append((theta, phi_odd if len(rings) % 2 else phi_even))
    if len(rings) % 2 == 0:                            # the top grid ring must be even
        rings.pop()
    return rings


def main(out: Path) -> None:
    rings = build_rings()
    n_rings = len(rings)
    nodes = {(j, k): surf(theta, phi) for j, (theta, ph) in enumerate(rings) for k, phi in enumerate(ph)}
    even_phi = rings[0][1]

    # girders: the two neighbouring node meridians around each direction -- the main X first
    # (the oculus arches pair girders 0/2 and 1/3), then the ribs
    girder_dirs = [(a, "main") for a in (ARCH_PSI, math.pi - ARCH_PSI, math.pi + ARCH_PSI, -ARCH_PSI)] + \
                  [(math.radians(a), "rib") for a in RIB_AZ]
    girders, kinds = [], [k for _, k in girder_dirs]
    for psi, _ in girder_dirs:
        pa = [plan_angle(surf(0.0, ph)) for ph in even_phi]
        k0 = max(range(M_BASE), key=lambda k: math.remainder(pa[k] - psi, 2 * math.pi)
                 if math.remainder(pa[k] - psi, 2 * math.pi) <= 0 else -9)
        girders.append((k0, (k0 + 1) % M_BASE))
    bands = [(plan_angle(surf(0.0, even_phi[k0])), plan_angle(surf(0.0, even_phi[k1]))) for k0, k1 in girders]

    def in_band(p):
        """Strictly between the two top-chord meridians of a girder or rib (plan angle)."""
        a = plan_angle(p)
        for a0, a1 in bands:
            w = math.remainder(a1 - a0, 2 * math.pi)
            t = math.remainder(a - a0, 2 * math.pi)
            if 1e-7 < t < w - 1e-7:
                return True
        return False

    # ---- IFC scaffolding ----
    f = api.run("project.create_file", version="IFC4")
    project = api.run("root.create_entity", f, ifc_class="IfcProject", name="Sample gridshell")
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "MILLIMETERS"})
    model = api.run("context.add_context", f, context_type="Model")
    body = api.run("context.add_context", f, context_type="Model", context_identifier="Body",
                   target_view="MODEL_VIEW", parent=model)
    axis_ctx = api.run("context.add_context", f, context_type="Model", context_identifier="Axis",
                       target_view="GRAPH_VIEW", parent=model)
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Gridshell hall")
    storey = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Gridshell")
    storey.Elevation = 0.0
    api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    api.run("aggregate.assign_object", f, relating_object=site, products=[building])
    api.run("aggregate.assign_object", f, relating_object=building, products=[storey])
    steel = api.run("material.add_material", f, name="S355", category="steel")

    profile_def = profile_defs(f)
    bars = []                            # (profile, tag, a, b, depth_dir) in mm, for write_analysis

    products, tags = [], set()
    nkey = lambda p: tuple(round(c, 4) for c in p)

    def member(cls, profile, tag, a, b, depth_dir, predefined=None):
        assert tag not in tags, tag
        tags.add(tag)
        a = tuple(c * 1000 for c in a); b = tuple(c * 1000 for c in b)
        d = norm(sub(b, a))
        length = math.dist(a, b)
        dd = dot(depth_dir, d)
        y = tuple(depth_dir[i] - dd * d[i] for i in range(3))
        y = norm(y) if math.hypot(*y) > 1e-9 else norm(cross(d, (1.0, 0.0, 0.0)))
        x = cross(y, d)
        bars.append((profile, tag, a, b, y))
        e = api.run("root.create_entity", f, ifc_class=cls, name=profile, predefined_type=predefined)
        e.Tag = tag
        e.ObjectPlacement = f.createIfcLocalPlacement(None, f.createIfcAxis2Placement3D(
            f.createIfcCartesianPoint([float(c) for c in a]),
            f.createIfcDirection([float(c) for c in d]), f.createIfcDirection([float(c) for c in x])))
        origin = f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0]), None, None)
        solid = f.createIfcExtrudedAreaSolid(profile_def(profile), origin, f.createIfcDirection([0.0, 0.0, 1.0]), length)
        line = f.createIfcPolyline([f.createIfcCartesianPoint([0.0, 0.0, 0.0]), f.createIfcCartesianPoint([0.0, 0.0, length])])
        e.Representation = f.createIfcProductDefinitionShape(None, None, [
            f.createIfcShapeRepresentation(axis_ctx, "Axis", "Curve3D", [line]),
            f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])])
        products.append(e)

    def shell_member(cls, profile, tag, a, b, predefined=None):
        member(cls, profile, tag, a, b, normal(mid(a, b)), predefined)

    # ---- door openings: centred in the gaps on both sides of each rib on DOOR_AXIS. Odd-ring
    # node k sits between even-ring nodes k and k+1, so an opening from column c1 is every bar
    # of the odd-ring nodes c1 .. c1 + DOOR_BAYS - 1 below ring DOOR_RINGS.
    assert DOOR_RINGS % 2 == 0
    doors, door_odd = [], set()
    for gi, (k0, k1) in enumerate(girders):
        e_dir = (math.cos(girder_dirs[gi][0]), math.sin(girder_dirs[gi][0]))
        if kinds[gi] != "rib" or abs(e_dir["xy".index(DOOR_AXIS)]) < 0.5:
            continue
        ccw = min((g0 - k1) % M_BASE for g0, _ in girders if (g0 - k1) % M_BASE > 0)   # gap widths
        cw = min((k0 - g1) % M_BASE for _, g1 in girders if (k0 - g1) % M_BASE > 0)
        for start, gap in ((k1, ccw), ((k0 - cw) % M_BASE, cw)):
            margin = (gap - DOOR_BAYS) // 2
            assert margin >= 1, "door wider than the gap"
            c1 = (start + margin) % M_BASE
            doors.append(c1)
            door_odd |= {(r, (c1 + i) % M_BASE) for r in range(1, DOOR_RINGS, 2) for i in range(DOOR_BAYS)}

    # ---- diagrid bars (none inside a girder's top face or a door opening) ----
    n_dg = 0
    for j in range(n_rings - 1):
        for k in range(M_BASE):
            q = nodes[(j + 1, k)]
            # ring j+1 node k sits over the half-step between nodes (k-1, k) or (k, k+1) below
            below = (k, (k + 1) % M_BASE) if j % 2 == 0 else ((k - 1) % M_BASE, k)
            for side, kb in zip("LR", below):
                p = nodes[(j, kb)]
                if in_band(mid(p, q)) or ((j + 1, k) if j % 2 == 0 else (j, kb)) in door_odd:
                    continue
                n_dg += 1
                shell_member("IfcMember", SECTIONS["diagrid"]["bar"], f"DG{j + 1:02d}-{k + 1:02d}{side}", p, q,
                             "MEMBER")
    for d, c1 in enumerate(doors, start=1):             # door frames: jambs + lintel, on the shell
        cs = [(c1 + i) % M_BASE for i in range(DOOR_BAYS + 1)]
        for side, c in (("L", cs[0]), ("R", cs[-1])):
            for r in range(0, DOOR_RINGS, 2):
                shell_member("IfcMember", SECTIONS["door"]["frame"], f"DOOR{d}-J{side}{r // 2 + 1}",
                             nodes[(r, c)], nodes[(r + 2, c)], "POST")
        for i in range(DOOR_BAYS):
            shell_member("IfcBeam", SECTIONS["door"]["frame"], f"DOOR{d}-H{i + 1}",
                         nodes[(DOOR_RINGS, cs[i])], nodes[(DOOR_RINGS, cs[i + 1])], "LINTEL")

    # ---- girders + ribs: trapezoidal four-chord lattice girders ----
    theta_top = rings[-1][0]
    z_top = C_H * math.sin(theta_top)
    z_crown = C_H * math.sqrt(1 - CROWN_K ** 2)
    z_outer = C_H * math.sqrt(1 - CROWN_OUTER_K ** 2)
    top_at = lambda q: (q[0], q[1], C_H * math.sqrt(max(0.0, 1 - (q[0] / A_X) ** 2 - (q[1] / B_Y) ** 2)))

    def bot_at(q):
        """Bottom-chord point over the oculus: on the inner ellipsoid depth_at() below the shell
        point above q -- a function of plan position only, so crossing chords meet exactly."""
        d = depth_at(top_at(q)[2])
        return (q[0], q[1], (C_H - d) * math.sqrt(max(0.0, 1 - (q[0] / (A_X - d)) ** 2 - (q[1] / (B_Y - d)) ** 2)))

    # frames: bisector at the top grid ring, symmetric chord offsets (sL, sR) = (-/+ h)
    frames = []
    for k0, k1 in girders:
        top_l, top_r = surf(theta_top, even_phi[k0]), surf(theta_top, even_phi[k1])
        a0, a1 = plan_angle(top_l), plan_angle(top_r)
        psi_c = a0 + math.remainder(a1 - a0, 2 * math.pi) / 2
        e_par = (math.cos(psi_c), math.sin(psi_c), 0.0)
        e_lat = (-math.sin(psi_c), math.cos(psi_c), 0.0)
        hl, hr = dot(top_l, e_lat), dot(top_r, e_lat)
        h = (hr - hl) / 2
        frames.append((e_par, e_lat, math.copysign(h, hl), math.copysign(h, hr)))

    def cross_plan(fa, sa, fb, sb):
        """Plan point where the chord line (frame fa, offset sa) meets (frame fb, offset sb);
        also returns the position u along fa."""
        pa, la, pb, lb = fa[0], fa[1], fb[0], fb[1]
        rx, ry = sb * lb[0] - sa * la[0], sb * lb[1] - sa * la[1]
        det = -pa[0] * pb[1] + pb[0] * pa[1]
        u = (-rx * pb[1] + pb[0] * ry) / det
        return (u * pa[0] + sa * la[0], u * pa[1] + sa * la[1]), u

    # crossing nodes over the oculus: where each chord line of arch 1 (G1-G3) meets each chord
    # line of arch 2 (G2-G4) -- on the shell (top chords) and the inner surface (bottom chords)
    xing = {}                                           # (level, line of arch 1, line of arch 2) -> node
    for level, ratio, at in (("T", 1.0, top_at), ("B", BOTTOM_WIDTH_RATIO, bot_at)):
        for oa, sa in enumerate(frames[0][2:]):
            for ob, sb in enumerate(frames[1][2:]):
                xing[(level, oa, ob)] = at(cross_plan(frames[0], math.copysign(BOX_WIDTH / 2, sa) * ratio,
                                                      frames[1], math.copysign(BOX_WIDTH / 2, sb) * ratio)[0])

    def girder_crossings(gi, level):
        """The crossing nodes a main girder's (left, right) chord runs into: the two on that
        chord's line, the nearer one to the girder's own feet."""
        e_par, e_lat, sL, sR = frames[gi]
        ratio = 1.0 if level == "T" else BOTTOM_WIDTH_RATIO
        pts = [q for k, q in xing.items() if k[0] == level]
        on_line = lambda s_: sorted(pts, key=lambda q: abs(dot(q, e_lat) - math.copysign(BOX_WIDTH / 2, s_) * ratio))[:2]
        return tuple(max(on_line(s_), key=lambda q: dot(q, e_par)) for s_ in (sL, sR))

    def section_bottoms(pl, pr):
        """Bottom chord points of the trapezoidal section whose top chords are at pl, pr."""
        ab = plan_angle(pl) + math.remainder(plan_angle(pr) - plan_angle(pl), 2 * math.pi) / 2
        ep, el = (math.cos(ab), math.sin(ab), 0.0), (-math.sin(ab), math.cos(ab), 0.0)
        c = inward(on_plane((pl[2] + pr[2]) / 2, ep, el, (dot(pl, el) + dot(pr, el)) / 2))
        e = norm(sub(pr, pl))
        hb = BOTTOM_WIDTH_RATIO * math.dist(pl, pr) / 2
        return add(c, e, -hb), add(c, e, hb)

    girder_bot, girder_ring = {}, {}
    girder_meta = {}                                    # girder -> (stations, starts left, last tops, last bottoms)
    for gi, (k0, k1) in enumerate(girders):
        kind = kinds[gi]
        sec = SECTIONS[kind]
        arm = f"G{gi + 1}" if kind == "main" else f"R{gi - kinds.index('rib') + 1}"
        fr = frames[gi]
        e_par, e_lat, sL, sR = fr
        TL, TR, fixed_b = [], [], []                    # fixed_b: bottoms set explicitly (oculus)
        for j in range(0, n_rings - 1, 2):              # diagrid zone
            for jj in ([j, j + 1] if max(math.dist(surf(rings[j][0], even_phi[k]), surf(rings[j + 2][0], even_phi[k]))
                                         for k in (k0, k1)) > GIRDER_SPLIT else [j]):
                TL.append(surf(rings[jj][0], even_phi[k0] if jj % 2 == 0 else even_phi[k0]))
                TR.append(surf(rings[jj][0], even_phi[k1]))
                fixed_b.append(None)
        # open band: top grid ring -> the crown ring girder's outer chord, constant width,
        # OPEN_PANELS equal arc lengths, none shorter than MIN_LATTICE_MEMBER on the bottom chord
        zs = [z_top + (z_outer - z_top) * i / 400 for i in range(401)]
        run, run_b = [0.0], [0.0]
        for z0, z1 in zip(zs, zs[1:]):
            run.append(run[-1] + math.dist(on_plane(z0, e_par, e_lat, 0.0), on_plane(z1, e_par, e_lat, 0.0)))
            run_b.append(run_b[-1] + math.dist(inward(on_plane(z0, e_par, e_lat, 0.0)),
                                               inward(on_plane(z1, e_par, e_lat, 0.0))))
        n_open = max(1, min(OPEN_PANELS, int(run_b[-1] / (1.02 * MIN_LATTICE_MEMBER))))
        for i in range(n_open + 1):
            z = zs[min(range(len(run)), key=lambda q: abs(run[q] - run[-1] * i / n_open))]
            TL.append(on_plane(z, e_par, e_lat, sL) if i else surf(theta_top, even_phi[k0]))
            TR.append(on_plane(z, e_par, e_lat, sR) if i else surf(theta_top, even_phi[k1]))
            fixed_b.append(None)
        io = len(TL) - 1                                # crown ring girder, outer station
        if kind == "main":                              # ... and its inner station (oculus edge)
            TL.append(on_plane(z_crown, e_par, e_lat, sL)); TR.append(on_plane(z_crown, e_par, e_lat, sR))
            fixed_b.append(None)
        ic = len(TL) - 1                                # crown station (ribs end at the outer one)
        if kind == "main":
            # over the oculus: OCULUS_PANELS equal panels from the crown ring to the girder's
            # crossing nodes, each chord straight in plan to its own
            starts = (TL[ic], TR[ic]) + section_bottoms(TL[ic], TR[ic])
            ends = girder_crossings(gi, "T") + girder_crossings(gi, "B")
            for i in range(1, OCULUS_PANELS + 1):
                t = i / OCULUS_PANELS
                pts = [e if i == OCULUS_PANELS else at((a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t))
                       for a, e, at in zip(starts, ends, (top_at, top_at, bot_at, bot_at))]
                TL.append(pts[0]); TR.append(pts[1])
                fixed_b.append((pts[2], pts[3]))
        BL, BR = [], []
        for pl, pr, fb in zip(TL, TR, fixed_b):
            bl_, br_ = fb or section_bottoms(pl, pr)
            BL.append(bl_); BR.append(br_)
        for t, b in zip(TL + TR, BL + BR):
            girder_bot[nkey(t)] = b
        n = len(TL)
        for side, T, B in (("L", TL, BL), ("R", TR, BR)):
            for i in range(n - 1):
                member("IfcBeam", sec["chord"], f"{arm}{side}-TC{i + 1:02d}", T[i], T[i + 1], normal(mid(T[i], T[i + 1])))
                member("IfcBeam", sec["chord"], f"{arm}{side}-BC{i + 1:02d}", B[i], B[i + 1], normal(mid(B[i], B[i + 1])))
                da, db = (B[i], T[i + 1]) if i % 2 == 0 else (T[i], B[i + 1])      # side face, Warren
                member("IfcMember", sec["side"], f"{arm}{side}-D{i + 1:02d}", da, db,
                       norm(cross(sub(T[i + 1], T[i]), sub(B[i], T[i]))), "BRACE")
            for i in range(n):
                if T[i][2] < 1e-9 or (kind == "main" and i == n - 1):   # feet: supports; crossings:
                    continue                                              # the box's posts
                member("IfcMember", sec["post"], f"{arm}{side}-V{i + 1:02d}", B[i], T[i],
                       norm(cross(sub(T[min(i + 1, n - 1)], T[max(i - 1, 0)]), sub(B[i], T[i]))), "STUD")
        # top / bottom faces: a strut at every station between the feet and the end frame (a
        # ring truss's chord where one meets the girder) ...
        for i in range(1, n - 1):
            ring = next((nm for nm, z in (("TOPGRID", z_top), ("CROWNO", z_outer), ("CROWNI", z_crown))
                         if abs(TL[i][2] - z) < 1e-6), None)
            for lvl, a_, b_ in (("T", TL[i], TR[i]), ("B", BL[i], BR[i])):
                if ring:
                    member("IfcBeam", SECTIONS["ring"]["chord"], f"{ring}-{arm}{lvl}", a_, b_, normal(mid(a_, b_)))
                else:
                    member("IfcMember", sec["frame"], f"{arm}-{lvl}S{i + 1:02d}", a_, b_, normal(mid(a_, b_)), "BRACE")
        # ... and a zigzag from the start chord: nearer the x axis (main arms) or on the + side of
        # the other axis (ribs) -- mirror images across both symmetry axes; top and bottom alike
        if kind == "main":
            s_left = abs(TL[0][1]) < abs(TR[0][1])
        elif abs(e_par[0]) > abs(e_par[1]):
            s_left = TL[0][1] > TR[0][1]
        else:
            s_left = TL[0][0] > TR[0][0]
        for lvl, L_, R_ in (("T", TL, TR), ("B", BL, BR)):
            S_, O_ = (L_, R_) if s_left else (R_, L_)
            for i in range(n - 1):
                a_, b_ = (S_[i], O_[i + 1]) if i % 2 == 0 else (O_[i], S_[i + 1])
                member("IfcMember", sec["lattice"], f"{arm}-{lvl}D{i + 1:02d}", a_, b_, normal(mid(a_, b_)), "BRACE")
        girder_meta[gi] = (n, s_left, (TL[-1], TR[-1]), (BL[-1], BR[-1]))
        girder_ring[gi] = (kind, fr, (TL[io], TR[io], BL[io], BR[io]), (TL[ic], TR[ic], BL[ic], BR[ic]))

    # ---- ring trusses: top chord on the shell, bottom chord inside, posts + Warren webs ----
    def ring_truss(name, pts):
        """pts: closed loop of (top, bottom, has_post, panel_after_is_ring). Panels flagged
        False belong to a girder: the ring stops there and the girder carries on."""
        n, c = len(pts), 0
        for i in range(n):
            t0, b0, post, panel = pts[i]
            t1, b1, _, _ = pts[(i + 1) % n]
            if post:
                member("IfcMember", SECTIONS["ring"]["post"], f"{name}-V{i + 1:02d}", b0, t0,
                       cross(normal(t0), sub(t1, t0)), "STUD")
            if not panel:
                c = 0
                continue
            shell_member("IfcBeam", SECTIONS["ring"]["chord"], f"{name}-TC{i + 1:02d}", t0, t1)
            member("IfcBeam", SECTIONS["ring"]["chord"], f"{name}-BC{i + 1:02d}", b0, b1, normal(mid(b0, b1)))
            da, db = (b0, t1) if c % 2 == 0 else (t0, b1)
            member("IfcMember", SECTIONS["ring"]["side"], f"{name}-D{i + 1:02d}", da, db,
                   cross(normal(t0), sub(t1, t0)), "BRACE")
            c += 1

    loop = []                                          # top grid ring, interrupted at the girders
    for k in range(M_BASE):
        t, t_next = nodes[(n_rings - 1, k)], nodes[(n_rings - 1, (k + 1) % M_BASE)]
        on_girder = nkey(t) in girder_bot
        loop.append((t, girder_bot[nkey(t)] if on_girder else inward(t), not on_girder, not in_band(mid(t, t_next))))
    ring_truss("TOPGRID", loop)

    # ---- crown ring girder: a trapezoidal four-chord ring around the oculus ----
    # A station is (outer top, inner top, outer bottom, inner bottom). At a main girder chord the
    # girder's own nodes; at a rib chord the rib's end nodes outside and that chord's plane
    # carried on to the oculus edge inside; in between, even steps along both rings.
    ring_at = lambda k, z, ph: (A_X * k * math.cos(ph), B_Y * k * math.sin(ph), z)
    par_of = lambda p: math.atan2(p[1] / B_Y, p[0] / A_X)
    counts = {}

    def ring_tag(prefix):
        counts[prefix] = counts.get(prefix, 0) + 1
        return f"{prefix}{counts[prefix]:02d}"

    def ring_steps(k, z, a, b, n):
        """The n - 1 points splitting the ring arc a -> b (counter-clockwise) evenly by length."""
        p0, span = par_of(a), (par_of(b) - par_of(a)) % (2 * math.pi)
        samp = [ring_at(k, z, p0 + span * i / 400) for i in range(401)]
        run = [0.0]
        for a_, b_ in zip(samp, samp[1:]):
            run.append(run[-1] + math.dist(a_, b_))
        return [samp[min(range(401), key=lambda q: abs(run[q] - run[-1] * i / n))] for i in range(1, n)]

    def between(x, y):
        n = max(1, round(math.dist(x[0], y[0]) / CROWN_PANEL))
        outs, ins = ring_steps(CROWN_OUTER_K, z_outer, x[0], y[0], n), ring_steps(CROWN_K, z_crown, x[1], y[1], n)
        return [(o, i) + section_bottoms(o, i) + ("mid",) for o, i in zip(outs, ins)]

    ccw_first = lambda a, b: math.remainder(plan_angle(a) - plan_angle(b), 2 * math.pi) < 0   # a before b
    mains = sorted((g for g in girder_ring if girder_ring[g][0] == "main"), key=lambda g: plan_angle(girder_ring[g][2][0]) % (2 * math.pi))
    ribs = [g for g in girder_ring if girder_ring[g][0] == "rib"]
    for ga, gb in zip(mains, mains[1:] + mains[:1]):
        def girder_station(g, last):
            o, i = girder_ring[g][2], girder_ring[g][3]
            c = 0 if ccw_first(o[0], o[1]) == last else 1          # the chord facing the segment
            return (o[c], i[c], o[2 + c], i[2 + c], "girder")
        a_st, b_st = girder_station(ga, last=False), girder_station(gb, last=True)
        rib = next(g for g in ribs if ccw_first(a_st[0], girder_ring[g][2][0]) and ccw_first(girder_ring[g][2][0], b_st[0]))
        _, (e_par, e_lat, sL, sR), o = girder_ring[rib][:3]
        rib_st = []
        for c, s_ in ((0, sL), (1, sR)):
            ti = on_plane(z_crown, e_par, e_lat, s_)                # the rib chord's plane, carried on
            rib_st.append((o[c], ti, o[2 + c], section_bottoms(o[c], ti)[1], "rib"))
        if not ccw_first(rib_st[0][0], rib_st[1][0]):
            rib_st.reverse()
        st = [a_st] + between(a_st, rib_st[0]) + rib_st + between(rib_st[1], b_st) + [b_st]
        r0 = st.index(rib_st[0])
        # stations: posts, radial struts (the girders already have theirs; the rib its outer post)
        for x in st:
            to, ti, bo, bi, kind = x
            if kind == "girder":
                continue
            if kind == "mid":
                member("IfcMember", SECTIONS["ring"]["post"], ring_tag("CROWNO-V"), bo, to, norm(sub(ti, to)), "STUD")
            member("IfcMember", SECTIONS["ring"]["post"], ring_tag("CROWNI-V"), bi, ti, norm(sub(ti, to)), "STUD")
            member("IfcMember", SECTIONS["ring"]["frame"], ring_tag("CROWN-TS"), to, ti, normal(mid(to, ti)), "BRACE")
            member("IfcMember", SECTIONS["ring"]["frame"], ring_tag("CROWN-BS"), bo, bi, normal(mid(bo, bi)), "BRACE")
        # the rib band's diagonals start on the side nearer the + side of the other axis
        e_rib = girder_ring[rib][1][0]
        ax_ = 1 if abs(e_rib[0]) > abs(e_rib[1]) else 0
        center_from_cw = st[r0][0][ax_] > st[r0 + 1][0][ax_]
        for k in range(len(st) - 1):
            x, y = st[k], st[k + 1]
            for nm, i0, i1 in (("CROWNO-TC", 0, 0), ("CROWNO-BC", 2, 2), ("CROWNI-TC", 1, 1), ("CROWNI-BC", 3, 3)):
                member("IfcBeam", SECTIONS["ring"]["chord"], ring_tag(nm), x[i0], y[i1], normal(mid(x[i0], y[i1])))
            # near = the station on the rib's side; q counts panels away from the rib band
            if k < r0:
                near, far, q = y, x, r0 - 1 - k
            elif k > r0:
                near, far, q = x, y, k - r0 - 1
            else:
                near, far, q = (x, y, 0) if center_from_cw else (y, x, 0)
            for nm, t_, b_ in (("CROWNO-D", 0, 2), ("CROWNI-D", 1, 3)):         # side faces, in phase
                a_, c_ = (near[b_], far[t_]) if q % 2 == 0 else (near[t_], far[b_])
                member("IfcMember", SECTIONS["ring"]["side"], ring_tag(nm), a_, c_, normal(mid(a_, c_)), "BRACE")
            for nm, o_, i_ in (("CROWN-TD", 0, 1), ("CROWN-BD", 2, 3)):         # top / bottom, alike
                a_, c_ = (near[o_], far[i_]) if q % 2 == 0 else (near[i_], far[o_])
                member("IfcMember", SECTIONS["ring"]["lattice"], ring_tag(nm), a_, c_, normal(mid(a_, c_)), "BRACE")

    # ---- the central box over the oculus, between the crossing nodes ----
    # every chord line runs on between its two crossings (that piece is also the last strut of
    # the other arch's girders); a post at every crossing
    for level in ("T", "B"):
        for o in range(2):
            for ai, (a_, b_) in enumerate(((xing[(level, o, 0)], xing[(level, o, 1)]),
                                            (xing[(level, 0, o)], xing[(level, 1, o)]))):
                member("IfcBeam", SECTIONS["main"]["chord"], f"X{ai + 1}{'LR'[o]}{level}C1", a_, b_, normal(mid(a_, b_)))
    for oa in range(2):
        for ob in range(2):
            t, b = xing[("T", oa, ob)], xing[("B", oa, ob)]
            member("IfcMember", SECTIONS["main"]["post"], f"X12-V{oa + 1}{ob + 1}", b, t,
                   norm(cross(frames[0][0], sub(t, b))), "STUD")
    # its four walls carry on the side-face alternation of girder G1 / G2 (one panel each: with
    # an odd count across the arch one break is unavoidable, it sits on the G3 / G4 side)
    for ai in range(2):
        e_par_a = frames[ai][0]
        for o in range(2):
            T, B = ([xing[(lv, o, k)] if ai == 0 else xing[(lv, k, o)] for k in range(2)] for lv in ("T", "B"))
            if dot(T[0], e_par_a) < dot(T[1], e_par_a):     # start at G1's / G2's side
                T, B = T[::-1], B[::-1]
            a_, b_ = (B[0], T[1]) if (girder_meta[ai][0] - 1) % 2 == 0 else (T[0], B[1])
            member("IfcMember", SECTIONS["main"]["side"], f"X{ai + 1}{'LR'[o]}-D01", a_, b_,
                   norm(cross(sub(T[1], T[0]), sub(B[0], T[0]))), "BRACE")
    # the rhombus diagonal carries on G1's top / bottom zigzag: from where its last diagonal ends
    # to the opposite crossing -- the same one on top and below
    n_g, s_left, tops, bots = girder_meta[0]
    for lvl, (l_, r_) in (("T", tops), ("B", bots)):
        s_, o_ = (l_, r_) if s_left else (r_, l_)
        e_ = o_ if (n_g - 2) % 2 == 0 else s_
        far = max((q for k, q in xing.items() if k[0] == lvl), key=lambda q: math.dist(q, e_))
        member("IfcMember", SECTIONS["main"]["lattice"], f"X12-{lvl}D", e_, far, normal(mid(e_, far)), "BRACE")

    api.run("spatial.assign_container", f, relating_structure=storey, products=products)
    api.run("material.assign_material", f, products=products, type="IfcMaterial", material=steel)
    out.parent.mkdir(parents=True, exist_ok=True)
    f.write(str(out))
    print(f"wrote {out}\n  {len(products)} members: {n_dg} diagrid bars on {n_rings} rings ({M_BASE} nodes each), "
          f"top grid ring at z = {z_top:.2f} m (scale {math.cos(theta_top):.2f}), crown ring girder at z = "
          f"{z_outer:.2f} / {z_crown:.2f} m; "
          f"X arches at +/-{math.degrees(ARCH_PSI):.1f} deg")
    sap = out.with_name(out.stem + "_sap.ifc")             # the same + the analysis model
    n_joints, n_supports = add_analysis(f, bars, {e.Tag: e for e in products}, building, steel, profile_def, model)
    f.write(str(sap))
    print(f"wrote {sap}\n  + analysis model: {len(bars)} curve members, {n_joints} joints, "
          f"{n_supports} pinned supports")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
