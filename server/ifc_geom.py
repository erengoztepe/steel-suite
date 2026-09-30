"""IFC (IDEA export) -> coped 2D part outlines by mesh projection + union.

IDEA's IFC meshes already have copes / cuts / holes baked in, so projecting each
solid part's triangles onto a view plane and unioning them yields the TRUE coped
silhouette (outer boundary incl. cope notches). This is the robust source of truth
for part geometry (the IOM gives clean bolts/welds/dims separately).
"""
from __future__ import annotations
import math
from collections import defaultdict
import ifcopenshell
import ifcopenshell.geom as geom
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, LineString, box
from shapely.ops import unary_union

# Solid parts drawn as outlines. Welds (IfcFastener) are NEVER drawn as geometry
# (shown only via the weld symbol); bolts (IfcMechanicalFastener) and openings from IOM.
SOLID_TYPES = {"IfcBeam", "IfcColumn", "IfcMember", "IfcPlate"}


def _settings():
    s = geom.settings()
    for setter in (lambda: s.set("use-world-coords", True),
                   lambda: s.set(s.USE_WORLD_COORDS, True)):
        try:
            setter(); break
        except Exception:
            continue
    return s


def load_parts(ifc_path: str, transform=None):
    """[(ifc_type, name, verts Nx3 mm, faces Mx3), ...] for solid parts.

    Always MILLIMETRES (IFC ships metres; `* 1000` converts). The document's unit base is NOT
    applied here: this module's tolerances are absolute mm values tuned against real steel, so the
    whole engine stays in mm and only its 2D output is scaled, at the point of emission in
    render.py. Scaling the mesh instead silently changed the drawing between unit modes.

    `transform` (a 3x3 rotation, row-major flat list of 9) rotates every vertex about the
    origin -- used by the rotation-invariance test to feed the SAME connection at an arbitrary
    orientation and confirm the drawing is unchanged (frames must be feature-derived, not
    tied to global axes; see pipeline-doctrine).

    NOTE ON WHAT THESE MESHES ARE: an un-cut rolled member arrives as a real I-PRISM -- 24 unique
    vertices = 12 per end face, with the web at +-tw/2 (measured: HEA260 web +-3.75, HEA160
    +-3.0). It is NOT a plain box, as earlier comments here and in views.ts claimed; 24 vertices
    is simply what a 12-point profile extrusion gives. The only thing genuinely missing is the
    ROOT FILLETS (the profile is sharp-cornered), which is why the parametric drawIProfile still
    exists. See docs/drawing-conventions.md 8.11.
    """
    R = np.array(transform, dtype=float).reshape(3, 3) if transform else None
    f = ifcopenshell.open(ifc_path)
    s = _settings()
    parts = []
    for p in f.by_type("IfcProduct"):
        if not getattr(p, "Representation", None) or p.is_a() not in SOLID_TYPES:
            continue
        try:
            sh = geom.create_shape(s, p)
        except Exception:
            continue
        v = np.array(sh.geometry.verts, dtype=float).reshape(-1, 3) * 1000.0
        if R is not None:
            v = v @ R.T
        fc = np.array(sh.geometry.faces, dtype=int).reshape(-1, 3)
        parts.append((p.is_a(), str(getattr(p, "Name", "") or ""), v, fc))
    return parts


def project_union(verts, faces, origin, u, v, crop=None, min_area=2.0):
    """Project triangles to (u,v) and union -> list of OUTER rings [[(x,y),...]] (mm).
    `crop`=(half_u, half_v) clips to a window around the joint (origin projects to 0,0),
    turning long members into stubs."""
    o = np.asarray(origin, float); U = np.asarray(u, float); V = np.asarray(v, float)
    d = verts - o
    pu = d @ U; pv = d @ V
    tris = []
    for a, b, c in faces:
        poly = Polygon([(pu[a], pv[a]), (pu[b], pv[b]), (pu[c], pv[c])])
        if poly.is_valid and poly.area > 1e-6:
            tris.append(poly)
    if not tris:
        return []
    merged = unary_union(tris).buffer(0.15).buffer(-0.15)  # weld coplanar seams
    if crop is not None:
        merged = merged.intersection(box(-crop[0], -crop[1], crop[0], crop[1]))
    geoms = merged.geoms if isinstance(merged, MultiPolygon) else [merged]
    rings = []
    for g in geoms:
        if g.is_empty or g.geom_type != "Polygon" or g.area < min_area:
            continue
        rings.append([(round(x, 3), round(y, 3)) for x, y in g.exterior.coords])
    return rings


def _silhouette(verts, faces, origin, u, v, crop=None):
    """Shapely (Multi)Polygon = union of projected triangles (coped silhouette)."""
    o = np.asarray(origin, float); U = np.asarray(u, float); V = np.asarray(v, float)
    d = verts - o; pu = d @ U; pv = d @ V
    tris = [Polygon([(pu[a], pv[a]), (pu[b], pv[b]), (pu[c], pv[c])]) for a, b, c in faces]
    tris = [t for t in tris if t.is_valid and t.area > 1e-6]
    if not tris:
        return None
    poly = unary_union(tris).buffer(0.15).buffer(-0.15)
    if crop is not None:
        poly = poly.intersection(box(-crop[0], -crop[1], crop[0], crop[1]))
    return None if poly.is_empty else poly


def _coords(geom):
    gt = geom.geom_type
    if gt in ("LineString", "LinearRing"):
        return [list(geom.coords)] if len(geom.coords) >= 2 else []
    if gt in ("MultiLineString", "GeometryCollection"):
        out = []
        for g in geom.geoms:
            out.extend(_coords(g))
        return out
    return []


def _face_normals(verts, faces):
    n = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    L = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.where(L < 1e-9, 1.0, L)


def _ray_hits(points, direction, v0, e1, e2, eps=1e-9):
    """Vectorized Moller-Trumbore ray-triangle test, batched over N points x M triangles
    (v0/e1/e2 = the triangles' first vertex + two edge vectors, precomputed once per mesh).
    For each point, casts a ray along `direction` and returns how many triangles it crosses at
    t > eps (i.e. material BETWEEN the point and whatever is `direction` away from it).

    This is the single kernel both `_point_in_mesh` (odd/even PARITY -> solid containment) and
    every occlusion query in RayOccluder (count >= 1 -> something blocks the view) build on --
    occlusion needs no parity, so overlapping/interpenetrating occluders are harmless there.
    Returns an (N,) int array."""
    d = np.asarray(direction, dtype=float)
    n = np.linalg.norm(d)
    d = d / n if n > eps else d
    pvec = np.cross(d, e2)                                    # (M,3)
    det = (e1 * pvec).sum(1)                                  # (M,)
    ok_tri = np.abs(det) > eps
    inv = np.zeros_like(det)
    inv[ok_tri] = 1.0 / det[ok_tri]

    P = np.asarray(points, dtype=float)
    if P.ndim == 1:
        P = P[None, :]
    tvec = P[:, None, :] - v0[None, :, :]                     # (N,M,3)
    a = (tvec * pvec[None, :, :]).sum(2) * inv[None, :]       # (N,M)
    qvec = np.cross(tvec, e1[None, :, :])                     # (N,M,3)
    b = (d[None, None, :] * qvec).sum(2) * inv[None, :]       # (N,M)
    t = (e2[None, :, :] * qvec).sum(2) * inv[None, :]         # (N,M)
    hit = ok_tri[None, :] & (a >= -eps) & (a <= 1 + eps) & (b >= -eps) & (a + b <= 1 + eps) & (t > 1e-6)
    return hit.sum(axis=1)


def _point_in_mesh(p, verts, faces):
    """Ray-cast parity test: True if point p is strictly inside the closed mesh.
    Fixed oblique ray direction avoids axis-aligned degeneracies."""
    d = np.array([0.3, 0.5, 0.8113017])
    v0 = verts[faces[:, 0]]; e1 = verts[faces[:, 1]] - v0; e2 = verts[faces[:, 2]] - v0
    counts = _ray_hits(np.asarray(p, dtype=float), d, v0, e1, e2)
    return int(counts[0]) % 2 == 1


def box_mesh(center, ax, ay, az, half):
    """Closed 8-vertex / 12-triangle box occluder, used for OCCLUSION ONLY (never drawn).

    Boxes are adequate here not because the IFC mesh is a box -- it is a real I-prism, see
    load_parts -- but because the occlusion test only asks "is there material between this point
    and the viewer". For that, a rolled I-section is exactly three slabs (top flange, bottom
    flange, web); the root fillets add material only in corners the slabs already cover, and
    overlapping boxes are harmless (the test counts hits, it does not use parity -- see
    _ray_hits). What boxes buy us over the IFC mesh is the flange/web DISTINCTION: the single
    prism cannot answer "behind the flange" vs "in the open space between flanges", so a bolt
    sitting in that gap would read as buried inside the solid.

    center: box centre (mm, global). ax,ay,az: unit local axes (need not be global X/Y/Z).
    half: (hx,hy,hz) half-extents along ax,ay,az respectively.
    Returns (verts (8,3), faces (12,3))."""
    ax = np.asarray(ax, dtype=float); ay = np.asarray(ay, dtype=float); az = np.asarray(az, dtype=float)
    hx, hy, hz = half
    c = np.asarray(center, dtype=float)
    signs = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
             (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    verts = np.array([c + sx * hx * ax + sy * hy * ay + sz * hz * az for sx, sy, sz in signs])
    # winding/outward-normal direction doesn't matter here -- the occlusion test (_ray_hits'
    # hit COUNT, not parity) is direction-agnostic for this use.
    faces = np.array([
        [0, 1, 2], [0, 2, 3],   # -z
        [4, 6, 5], [4, 7, 6],   # +z
        [0, 4, 5], [0, 5, 1],   # -y
        [3, 2, 6], [3, 6, 7],   # +y
        [0, 3, 7], [0, 7, 4],   # -x
        [1, 5, 6], [1, 6, 2],   # +x
    ])
    return verts, faces


class RayOccluder:
    """Triangle-soup visibility test, built ONCE per view from every occluder mesh that view
    needs (IFC plate solids + parametric member boxes -- see box_mesh). Overlapping or
    interpenetrating meshes are harmless: the test only asks whether ANY triangle sits between
    a point and the viewer, not a signed/parity containment test."""

    def __init__(self, meshes=()):
        vs, fs, offset = [], [], 0
        for verts, faces in meshes:
            verts = np.asarray(verts, dtype=float)
            faces = np.asarray(faces, dtype=int)
            if len(faces) == 0 or len(verts) == 0:
                continue
            vs.append(verts)
            fs.append(faces + offset)
            offset += len(verts)
        if vs:
            self.verts = np.concatenate(vs, axis=0)
            faces_all = np.concatenate(fs, axis=0)
            self.v0 = self.verts[faces_all[:, 0]]
            self.e1 = self.verts[faces_all[:, 1]] - self.v0
            self.e2 = self.verts[faces_all[:, 2]] - self.v0
        else:
            self.v0 = self.e1 = self.e2 = np.zeros((0, 3))

    def hidden(self, points, direction) -> np.ndarray:
        """(N,) bool: True where a ray from `points` toward the viewer (`direction`) crosses
        at least one occluder triangle."""
        if len(self.v0) == 0:
            return np.zeros(len(np.atleast_2d(points)), dtype=bool)
        return _ray_hits(points, direction, self.v0, self.e1, self.e2) >= 1


def _sample_polyline(pts, samples_per_mm):
    samples = []
    for a, b in zip(pts, pts[1:]):
        length = float(np.linalg.norm(b - a))
        n = max(1, int(math.ceil(length * samples_per_mm)))
        for k in range(n):
            samples.append(a + (k / n) * (b - a))
    samples.append(pts[-1])
    return samples


def _bisect_crossing(p_vis, p_hid, occluder: "RayOccluder", direction, iters):
    """Binary-search the boundary between a VISIBLE sample and a HIDDEN sample so a clipped
    run ends exactly on the occluder surface instead of at the coarse sample spacing."""
    lo, hi = p_vis, p_hid
    for _ in range(iters):
        mid = (lo + hi) / 2.0
        if occluder.hidden(mid[None, :], direction)[0]:
            hi = mid
        else:
            lo = mid
    return lo


def clip_polyline(points3d, closed, occluder: "RayOccluder", direction, mode="segment",
                   samples_per_mm=2.0, refine=14, min_keep=0.5):
    """Visible sub-polylines (3D, mm) of a 3D polyline, given an occluder and a view direction
    pointing TOWARD THE VIEWER. mode='segment' finds maximal visible runs along the polyline,
    bisecting each visible/hidden boundary onto the occluder surface (used for a bolt seen
    side-on: the shank disappears exactly where it enters a plate). mode='whole' is
    all-or-nothing over the ENTIRE polyline (used for oblique views, e.g. the isometric, where
    a ragged partial clip would look worse than an honest all/nothing call -- e.g. of 4 bolts
    seen obliquely, only the ones not behind another bolt are drawn).

    Deterministic: fixed sampling density + bisection depth, 3dp rounding, fragments shorter
    than `min_keep` mm dropped -- required for golden-snapshot regression stability."""
    pts = [np.asarray(p, dtype=float) for p in points3d]
    if closed and len(pts) > 1 and not np.allclose(pts[0], pts[-1]):
        pts = pts + [pts[0]]
    if len(pts) < 2:
        return []
    samples = _sample_polyline(pts, samples_per_mm)
    hid = occluder.hidden(np.array(samples), direction)

    if mode == "whole":
        if hid.mean() > 0.5:
            return []
        return [[tuple(round(float(x), 3) for x in p) for p in pts]]

    runs: list[list[np.ndarray]] = []
    current: list[np.ndarray] | None = None
    for i, p in enumerate(samples):
        if hid[i]:
            if current is not None:
                boundary = _bisect_crossing(samples[i - 1], p, occluder, direction, refine)
                current.append(boundary)
                runs.append(current)
                current = None
            continue
        if current is None:
            current = []
            if i > 0 and hid[i - 1]:
                boundary = _bisect_crossing(p, samples[i - 1], occluder, direction, refine)
                current.append(boundary)
        current.append(p)
    if current is not None:
        runs.append(current)

    out = []
    for run in runs:
        if len(run) < 2:
            continue
        length = sum(float(np.linalg.norm(run[k + 1] - run[k])) for k in range(len(run) - 1))
        if length < min_keep:
            continue
        out.append([tuple(round(float(x), 3) for x in p) for p in run])
    return out


def _edge_buried(pi, pj, n1, n2, verts, faces, eps=0.5):
    """A crease edge is 'buried' (an internal mesh seam, e.g. where a web solid's cap
    abuts a flange solid) when the part's material sits on the OUTWARD side of BOTH
    adjacent faces -- i.e. both faces are internal, not real surfaces. Such seams are
    occluded by the part's own material and must not be drawn. Exposed edges (flange-top
    surface, tips, copes) have open air off at least one face normal -> kept.
    Assumes outward-consistent mesh normals (ifcopenshell meshes are)."""
    if float(np.dot(n1, n2)) < -0.99:  # coincident faces, opposite normals => internal sheet
        return True
    mid = (pi + pj) / 2.0
    return _point_in_mesh(mid + eps * n1, verts, faces) and _point_in_mesh(mid + eps * n2, verts, faces)


_crease_cache: dict = {}


def _crease_edges(verts, faces, min_len=25.0, angle_deg=20.0):
    """The VIEW-INDEPENDENT part of feature-edge extraction: which mesh edges are sharp/
    boundary creases (not buried internal seams), long enough to keep. `_edge_buried`'s
    per-edge point-in-mesh tests are the dominant cost of the IFC pass and are IDENTICAL for a
    given part across every view -- memoized by (id(verts), id(faces), min_len, angle_deg) so
    adding another view (e.g. a PLAN alongside FRONT/SECTION/ISO) is nearly free instead of
    re-paying this cost per view. Returns [(vi, vj), ...] vertex-index pairs, NOT yet projected."""
    key = (id(verts), id(faces), min_len, angle_deg)
    cached = _crease_cache.get(key)
    if cached is not None:
        return cached
    fn = _face_normals(verts, faces)
    ef = defaultdict(list)
    for fi, tri in enumerate(faces):
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        for i, j in ((a, b), (b, c), (c, a)):
            ef[(min(i, j), max(i, j))].append(fi)
    cos_t = math.cos(math.radians(angle_deg))
    out = []
    for (i, j), fs in ef.items():
        sharp = len(fs) == 1 or (len(fs) >= 2 and float(np.dot(fn[fs[0]], fn[fs[1]])) < cos_t)
        if not sharp or float(np.linalg.norm(verts[i] - verts[j])) < min_len:
            continue
        if len(fs) >= 2 and _edge_buried(verts[i], verts[j], fn[fs[0]], fn[fs[1]], verts, faces):
            continue
        out.append((i, j))
    _crease_cache[key] = out
    return out


def _edge_on_faces_2d(verts, faces, origin, u, v, normal, min_len=25.0, sin_tol=0.02):
    """Faces seen EDGE-ON in this view, as projected line segments + their nearest depth.

    A face whose normal is perpendicular to the view direction projects to a LINE, contributes no
    area, and so is invisible to both `project_union` (which unions AREAS) and `_crease_edges`
    (which looks at edges, not faces). Yet such a face is often the most important line in the
    view: in a plan, an I-member's web side faces are exactly this, and they are what makes the
    web read as a dashed pair under the flange.

    Why this is needed rather than relying on the web/flange crease edge: the IFC ships a rolled
    member as an INTERPENETRATING union of slabs -- the web slab runs into the middle of each
    flange (measured on HEA260: web long edges at z = +-118.75, inside the flange's 112.5..125
    band). Those junction edges are therefore genuinely INTERNAL, and `_crease_edges` is right to
    drop them. Worse, `_edge_buried` decides that via `_point_in_mesh`, a ray-PARITY test, which
    is unsound on a self-intersecting mesh: the two mirror-image web edges got opposite answers
    (x=-3.75 kept, x=+3.75 dropped), so the plan drew one web face and not the other. Deriving the
    line from the FACE instead of from its edges avoids the parity question altogether.

    Segments lying on the same projected line are merged, so a quad split into two triangles
    yields one segment rather than two touching halves.
    """
    o = np.asarray(origin, float); U = np.asarray(u, float); V = np.asarray(v, float)
    N = np.asarray(normal, float)
    N = N / (np.linalg.norm(N) or 1.0)
    fn = _face_normals(verts, faces)
    d = verts - o
    pu = d @ U; pv = d @ V; dep = d @ N
    groups: dict = {}
    for fi, (a, b, c) in enumerate(faces):
        if abs(float(np.dot(fn[fi], N))) > sin_tol:      # not edge-on
            continue
        idx = (int(a), int(b), int(c))
        p2 = [(pu[i], pv[i]) for i in idx]
        # the three points are collinear (the face is edge-on); take the extreme pair
        far = max(((math.dist(p2[i], p2[j]), i, j) for i in range(3) for j in range(i + 1, 3)))
        L, i0, i1 = far
        if L < min_len:
            continue
        pa, pb = p2[i0], p2[i1]
        # key the group on the infinite line: direction (sign-normalised) + signed offset
        dx, dy = pb[0] - pa[0], pb[1] - pa[1]
        n = math.hypot(dx, dy) or 1.0
        ux, uy = dx / n, dy / n
        if (ux, uy) < (-ux, -uy):
            ux, uy = -ux, -uy
        off = pa[0] * (-uy) + pa[1] * ux
        key = (round(ux, 4), round(uy, 4), round(off, 3))
        t = [pa[0] * ux + pa[1] * uy, pb[0] * ux + pb[1] * uy]
        near = float(max(dep[i] for i in idx))           # nearest point of this face
        g = groups.get(key)
        if g is None:
            groups[key] = [min(t), max(t), (ux, uy), off, near]
        else:
            g[0] = min(g[0], min(t)); g[1] = max(g[1], max(t)); g[4] = max(g[4], near)
    out = []
    for t0, t1, (ux, uy), off, near in groups.values():
        if t1 - t0 < min_len:
            continue
        px, py = -uy * off, ux * off        # a point on the line
        out.append((LineString([(px + ux * t0, py + uy * t0), (px + ux * t1, py + uy * t1)]), near))
    return out


def _feature_edges_2d(verts, faces, origin, u, v, normal, angle_deg=20.0, min_len=25.0):
    """Project the (memoized, view-independent) crease edges from `_crease_edges` into THIS
    view's 2D + depth, PLUS the lines of any faces seen edge-on (see _edge_on_faces_2d).
    Returns [(LineString, depth), ...] where depth is higher = nearer the viewer (self-HLR)."""
    edges = _crease_edges(verts, faces, min_len=min_len, angle_deg=angle_deg)
    o = np.asarray(origin, float); U = np.asarray(u, float); V = np.asarray(v, float); N = np.asarray(normal, float)
    segs = []
    for i, j in edges:
        pi = verts[i] - o; pj = verts[j] - o
        segs.append((LineString([(pi @ U, pi @ V), (pj @ U, pj @ V)]),
                     float((pi @ N + pj @ N) / 2.0)))
    segs += _edge_on_faces_2d(verts, faces, origin, u, v, normal, min_len=min_len)
    return segs


def _near_skin(verts, faces, origin, u, v, normal, tol):
    """Projected footprint (shapely polygon) of the part's NEAREST SURFACE -- the faces coplanar
    with its frontmost depth, i.e. the near flange seen face-on. Used as a self-occluder: the
    part's own deeper edges falling inside this footprint are hidden behind it.

    `tol` is a PLANARITY tolerance (how far a face may sit behind `dmax` and still count as part
    of the same near surface), and it must stay well BELOW the near flange's thickness. It used to
    be `0.06 * depth_range`, which is 15.0 for an HEA260 -- thicker than that section's own 12.5mm
    flange. The web/flange junction edge (at dmax - 12.5) therefore fell INSIDE the "near surface"
    slice, was not treated as being behind it, and the web came out SOLID in plan: the very case
    self-HLR exists to handle. A fraction of the depth RANGE is the wrong quantity; the near
    surface is planar, so a tight coplanarity tolerance is the right one.
    """
    o = np.asarray(origin, float); U = np.asarray(u, float); V = np.asarray(v, float); N = np.asarray(normal, float)
    d = verts - o; pu = d @ U; pv = d @ V; dep = d @ N
    dmax = float(dep.max())
    polys = []
    for a, b, c in faces:
        if (dep[a] + dep[b] + dep[c]) / 3.0 > dmax - tol:
            p = Polygon([(pu[a], pv[a]), (pu[b], pv[b]), (pu[c], pv[c])])
            if p.is_valid and p.area > 1e-6:
                polys.append(p)
    if not polys:
        return None, dmax
    return unary_union(polys).buffer(0.2).buffer(-0.2), dmax


def _dedupe_polylines(lines, prec=3):
    """Drop polylines that repeat one already emitted (same points, either direction).

    The per-part emission loop below hands the same edge to `emit` more than once -- a shared
    silhouette/feature edge, or the same ring reached from two parts -- so the same coordinates
    were written 2-4x. Measured in our own output before this: SECTION A-A had 100 `hidden`
    segments for 32 unique ones, PLAN 64 `visible` for 36 (docs 8.12/D3). Duplicates are
    invisible on screen but double every line's plotted weight and every grip the detailer drags.
    """
    seen, out = set(), []
    for ln in lines:
        pts = tuple((round(x, prec), round(y, prec)) for x, y in ln)
        if len(pts) < 2:
            continue
        key = min(pts, tuple(reversed(pts)))
        if key in seen:
            continue
        seen.add(key)
        out.append(ln)
    return out


def view_linework(parts, origin, u, v, crop=None, flip=False, min_len=25.0,
                  inter_part_hlr=True, self_hlr=True, hlr=None):
    """Returns (visible, hidden) coordinate polylines (drawing units): coped silhouette outline
    PLUS internal feature edges (flange lines etc.). Feature edges are clipped to the interior of
    their own part (the silhouette already draws the outer outline). `flip` negates the depth axis
    (view from the opposite side) -- e.g. a plan looks DOWN from above so the top (coped) flange
    is the near face. `min_len` is the shortest feature edge kept: the default (25) suppresses
    bolt-hole facets for elevations; a section/plan wanting the real cut detail (flange notches,
    web holes) lowers it.

    HIDDEN-LINE REMOVAL IS TWO INDEPENDENT SWITCHES, because they answer different questions and
    a view can legitimately want one without the other:

    * `inter_part_hlr` -- is this edge behind ANOTHER part? Ranks parts by MEAN depth, which is
      wrong whenever two parts' near faces are flush: in a plan, the bearing and carried members'
      top flanges sit at the same z, and mean depth then declares the shallower member "nearer"
      and chops the other's flange edge into dashes. A plan therefore turns this OFF.
    * `self_hlr` -- is this edge behind THIS part's own near face? That is what makes a web read
      dashed under its own flange in a plan, so a plan very much wants it ON.

    They used to be one `hlr` flag. The plan set `hlr=False` for the inter-part reason above and
    silently lost self-HLR with it, so the bearing member's web was emitted SOLID -- and then
    views.ts drew a parametric DASHED web over the top of it, giving one web face solid and the
    other dashed. `hlr` is still accepted so older specs keep working, but it drives both.
    See docs/drawing-conventions.md 8.12/D4-D5.
    """
    if hlr is not None:
        inter_part_hlr = self_hlr = bool(hlr)
    o = np.asarray(origin, float)
    normal = np.cross(np.asarray(u, float), np.asarray(v, float))
    if flip:
        normal = -normal
    entries = []
    for _typ, _name, verts, faces in parts:
        poly = _silhouette(verts, faces, origin, u, v, crop)
        if poly is None:
            continue
        feats = _feature_edges_2d(verts, faces, origin, u, v, normal, min_len=min_len)
        dep = (verts - o) @ normal
        # Coplanarity tolerance for "part of the near surface", plus the margin an edge must clear
        # to count as BEHIND it. Both are tiny fractions of the part's own depth range, so they
        # scale with the unit base and stay far below any real flange thickness -- see _near_skin
        # on why a thickness-sized band silently defeated self-HLR.
        rng = float(dep.max() - dep.min())
        tol = max(1e-3 * rng, 1e-9)
        margin = 2e-3 * rng
        skin, dmax = (_near_skin(verts, faces, origin, u, v, normal, tol)
                      if self_hlr else (None, 0.0))
        entries.append((poly, float(dep.mean()), feats, skin, dmax, tol + margin))

    visible, hidden = [], []
    for poly, depth, feats, skin, dmax, behind in entries:
        nearer = [p for p, d, _, _, _, _ in entries if d > depth + 1.0] if inter_part_hlr else []
        occ = unary_union(nearer) if nearer else None
        interior = poly.buffer(-0.5)  # keep feature edges strictly inside the outline

        def emit(g, occluder):
            if occluder is not None and not occluder.is_empty:
                nonlocal visible, hidden
                visible += _coords(g.difference(occluder))
                hidden += _coords(g.intersection(occluder))
            else:
                visible += _coords(g)

        # outer outline(s): occluded only by nearer OTHER parts (it is the near boundary)
        for ring in (poly.geoms if isinstance(poly, MultiPolygon) else [poly]):
            emit(ring.exterior, occ)
        # feature edges: add self-skin to the occluder when the edge sits behind the near flange
        for seg, ed in feats:
            g = seg.intersection(interior)
            if g.is_empty:
                continue
            occl = occ
            if skin is not None and ed < dmax - behind:
                occl = unary_union([o for o in (occ, skin) if o is not None])
            emit(g, occl)
    return _dedupe_polylines(visible), _dedupe_polylines(hidden)


# standard isometric basis
def iso_frame():
    u = np.array([1, -1, 0]) / math.sqrt(2)
    v = np.array([-1, -1, 2]) / math.sqrt(6)
    return u, v


if __name__ == "__main__":
    import sys
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from pathlib import Path

    repo_root = Path(__file__).resolve().parent.parent   # server/ -> repo root
    path = sys.argv[1] if len(sys.argv) > 1 else str(repo_root / "fixtures" / "fin_plate.ifc")
    parts = load_parts(path)
    print(f"solid parts: {[(t, n) for t, n, _, _ in parts]}")

    O = [0, 0, 0]
    views = {
        "FRONT (look +X)": ([0, 1, 0], [0, 0, 1]),
        "SECTION (look +Y)": ([1, 0, 0], [0, 0, 1]),
        "ISOMETRIC": tuple(iso_frame()),
    }
    fig, axes = plt.subplots(1, 3, figsize=(18, 7), facecolor="white")
    for ax, (title, (u, v)) in zip(axes, views.items()):
        for _, _, verts, faces in parts:
            for ring in project_union(verts, faces, O, u, v):
                xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
                ax.plot(xs, ys, "k-", lw=0.8)
        ax.set_aspect("equal"); ax.set_title(title); ax.axis("off")
    out_png = repo_root / "output" / "ifc_silhouettes.png"
    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=140, facecolor="white")
    print("wrote output/ifc_silhouettes.png")
