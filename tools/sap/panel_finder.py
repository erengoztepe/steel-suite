"""Find the panels enclosed by a graph of frame members.

Pure geometry, no SAP2000 dependency (see ``fill_panels.py`` for the OAPI side).

A panel is a 3-cycle (triangle) or a 4-cycle (quad) of frames that bounds an
empty face. Quads are emitted as two triangles split along the shorter diagonal;
triangles are emitted as they are.

Candidate rules
  * triangle: every 3-cycle.
  * quad: a 4-cycle with NO diagonal frame (a single diagonal means the quad is
    already two triangles), or with BOTH diagonals crossing each other
    (X-bracing without a joint at the crossing).
Rejection rules (each one kills a class of fake cycle, not a single case)
  * degenerate: (near) collinear triangle.
  * warped:     the two halves of a quad fold more than ``max_fold_deg``.
  * pierced:    another frame crosses the face interior.
  * occupied:   another joint projects into the face within ``occupied_height``
                (x face size) of its plane, e.g. the hub of a fan of triangles on
                a curved surface, or the far chord of a box truss.
  * not skin:   (``skin_only``, default) a ray from the face, on the side facing
                away from the structure's centre, hits another face -> the face is
                inside a truss / behind the envelope.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Options:
    max_fold_deg: float = 30.0
    skin_only: bool = True
    occupied_height: float = 0.25
    rel_tol: float = 1e-6


@dataclass
class Panel:
    nodes: tuple[str, str, str]       # triangle, oriented (right-hand normal)
    origin: tuple[str, ...]           # the 3- or 4-cycle it came from


@dataclass
class Result:
    panels: list[Panel] = field(default_factory=list)
    rejected: list[tuple[tuple[str, ...], str]] = field(default_factory=list)
    nonmanifold_edges: list[tuple[str, str]] = field(default_factory=list)
    skipped_existing: int = 0


def _normal(p0, p1, p2):
    return np.cross(p1 - p0, p2 - p0)


def _canon_cycle(cyc):
    """Rotation/direction-independent key of a cycle."""
    return frozenset(frozenset((cyc[i], cyc[(i + 1) % len(cyc)])) for i in range(len(cyc)))


def find_panels(coords: dict[str, tuple[float, float, float]],
                frames: list[tuple[str, str]],
                existing: list[tuple[str, ...]] = (),
                opts: Options = Options()) -> Result:
    xyz = {k: np.asarray(v, dtype=float) for k, v in coords.items()}
    edges = {frozenset(e) for e in frames if e[0] != e[1]}
    adj: dict[str, set[str]] = defaultdict(set)
    for e in edges:
        a, b = tuple(e)
        adj[a].add(b)
        adj[b].add(a)

    res = Result()
    if not edges:
        return res
    lengths = [np.linalg.norm(xyz[a] - xyz[b]) for a, b in (tuple(e) for e in edges)]
    eps = opts.rel_tol * float(np.median(lengths))

    # -- candidates ---------------------------------------------------------
    cands: dict[frozenset, tuple[str, ...]] = {}
    for a in adj:
        for b in adj[a]:
            for c in adj[a] & adj[b]:
                if a < b < c:
                    cyc = (a, b, c)
                    cands.setdefault(_canon_cycle(cyc), cyc)
        nb = sorted(adj[a])
        for i, b in enumerate(nb):
            for d in nb[i + 1:]:
                for c in (adj[b] & adj[d]) - {a}:
                    if c in (b, d):
                        continue
                    ac, bd = c in adj[a], d in adj[b]
                    if ac != bd:
                        continue  # one diagonal: already two triangles
                    if ac and not _segments_cross(xyz[a], xyz[c], xyz[b], xyz[d], eps):
                        continue  # both diagonals but not an X (e.g. tetrahedron)
                    cyc = (a, b, c, d)
                    cands.setdefault(_canon_cycle(cyc), cyc)

    # -- split + geometric filters -----------------------------------------
    faces: list[tuple[tuple[str, ...], list[tuple[str, str, str]]]] = []
    for cyc in cands.values():
        if len(cyc) == 3:
            tris = [cyc]
        else:
            a, b, c, d = cyc
            if np.linalg.norm(xyz[a] - xyz[c]) <= np.linalg.norm(xyz[b] - xyz[d]):
                tris = [(a, b, c), (a, c, d)]
                alt = [(b, c, d), (b, d, a)]
            else:
                tris = [(b, c, d), (b, d, a)]
                alt = [(a, b, c), (a, c, d)]
            fold = min(_fold_deg(xyz, *tris), _fold_deg(xyz, *alt))
            if fold > opts.max_fold_deg:
                res.rejected.append((cyc, f"warped ({fold:.0f} deg)"))
                continue
        if any(np.linalg.norm(_normal(*(xyz[n] for n in t))) <= eps * max(lengths) for t in tris):
            res.rejected.append((cyc, "degenerate"))
            continue
        faces.append((cyc, tris))

    # vectorised pierce / occupancy tests
    E = [tuple(e) for e in edges]
    P0 = np.array([xyz[a] for a, _ in E])
    P1 = np.array([xyz[b] for _, b in E])
    node_names = list(xyz)
    N = np.array([xyz[n] for n in node_names])
    kept = []
    for cyc, tris in faces:
        own = set(cyc)
        mask = np.array([not (a in own and b in own) for a, b in E])
        reason = None
        # a quad's halves share the diagonal: treat it as interior, not boundary
        shared = [2, 0] if len(tris) == 2 else [None]
        for t, diag in zip(tris, shared):
            T = np.array([xyz[n] for n in t])
            if _pierced(T, P0[mask], P1[mask], eps, diag):
                reason = "pierced by a frame"
                break
            nmask = np.array([n not in own for n in node_names])
            if _occupied(T, N[nmask], opts.occupied_height, eps, diag):
                reason = "joint inside"
                break
        if reason:
            res.rejected.append((cyc, reason))
        else:
            kept.append((cyc, tris))

    if opts.skin_only:
        kept = _outer_skin(kept, xyz, eps, res)

    # -- drop panels that already exist as area objects --------------------
    have = {frozenset(x) for x in existing}
    out = []
    for cyc, tris in kept:
        if frozenset(cyc) in have or all(frozenset(t) in have for t in tris):
            res.skipped_existing += 1
            continue
        out.extend(Panel(tuple(t), cyc) for t in tris)

    # -- manifold report + consistent orientation --------------------------
    per_edge = defaultdict(int)
    for cyc, _ in kept:
        for i in range(len(cyc)):
            per_edge[frozenset((cyc[i], cyc[i - 1]))] += 1
    res.nonmanifold_edges = sorted(tuple(sorted(e)) for e, n in per_edge.items() if n > 2)
    res.panels = _orient(out, xyz)
    return res


def _outer_skin(faces, xyz, eps, res):
    """Keep the faces seen from outside: a ray from the face, on the side
    facing away from the structure's centre, must leave without hitting
    another face. Drops truss interiors (inner chord faces, cross frames)."""
    if not faces:
        return faces
    T = np.array([[xyz[n] for n in t] for _, tris in faces for t in tris])
    owner = np.array([i for i, (_, tris) in enumerate(faces) for _ in tris])
    allp = np.array(list(xyz.values()))
    centre = (allp.min(0) + allp.max(0)) / 2
    e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
    nrm = np.cross(e1, e2)
    nrm /= np.linalg.norm(nrm, axis=1)[:, None]
    cen = T.mean(1)
    side = np.sign(np.einsum("ij,ij->i", nrm, cen - centre))
    side[side == 0] = 1
    kept = []
    for i, (cyc, _) in enumerate(faces):
        escapes = False
        for k in np.flatnonzero(owner == i):
            d = side[k] * nrm[k]
            if not _ray_hits(cen[k] + d * 1e3 * eps, d, T[owner != i], e1[owner != i],
                             e2[owner != i], eps):
                escapes = True
                break
        if escapes:
            kept.append(faces[i])
        else:
            res.rejected.append((cyc, "not on the outer skin"))
    return kept


def _ray_hits(o, d, T, e1, e2, eps):
    """Moller-Trumbore, ray o + t d (t > 0) against triangles T (vectorised)."""
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    ok = np.abs(det) > 1e-12 * np.einsum("ij,ij->i", e1, e1)
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = o - T[:, 0]
    u = np.einsum("ij,ij->i", s, p) * inv
    q = np.cross(s, e1)
    v = (q @ d) * inv
    t = np.einsum("ij,ij->i", e2, q) * inv
    return bool(np.any(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > eps)))


def _fold_deg(xyz, t1, t2):
    n1 = _normal(*(xyz[n] for n in t1))
    n2 = _normal(*(xyz[n] for n in t2))
    c = np.dot(n1, n2) / (np.linalg.norm(n1) * np.linalg.norm(n2) + 1e-300)
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def _segments_cross(a, c, b, d, eps):
    """True if segments ac and bd (nearly) intersect at interior points."""
    u, v, w = c - a, d - b, a - b
    uu, uv, vv, uw, vw = u @ u, u @ v, v @ v, u @ w, v @ w
    den = uu * vv - uv * uv
    if den <= eps * eps * uu * vv:
        return False
    s = (uv * vw - vv * uw) / den
    t = (uu * vw - uv * uw) / den
    if not (0 < s < 1 and 0 < t < 1):
        return False
    gap = np.linalg.norm((a + s * u) - (b + t * v))
    return gap <= 0.05 * min(np.sqrt(uu), np.sqrt(vv))


def _pierced(T, P0, P1, eps, open_edge=None):
    """Does any segment P0->P1 pass through the open interior of triangle T?"""
    if len(P0) == 0:
        return False
    lo, hi = T.min(0) - eps, T.max(0) + eps
    box = np.all(np.minimum(P0, P1) <= hi, 1) & np.all(np.maximum(P0, P1) >= lo, 1)
    P0, P1 = P0[box], P1[box]
    if len(P0) == 0:
        return False
    n = _normal(*T)
    n = n / np.linalg.norm(n)
    d0 = (P0 - T[0]) @ n
    d1 = (P1 - T[0]) @ n
    size = np.linalg.norm(T[1] - T[0])
    tol = max(eps, 1e-4 * size)

    # transverse: ends strictly on opposite sides, hit point strictly inside
    trans = (d0 * d1 < 0) & (np.abs(d0) > tol) & (np.abs(d1) > tol)
    if trans.any():
        s = d0[trans] / (d0[trans] - d1[trans])
        X = P0[trans] + s[:, None] * (P1[trans] - P0[trans])
        if np.any(_strictly_inside(T, n, X, tol, open_edge)):
            return True

    # coplanar: sample the segment, any sample strictly inside -> crosses
    cop = (np.abs(d0) <= tol) & (np.abs(d1) <= tol)
    if cop.any():
        ts = np.linspace(0.0, 1.0, 33)[1:-1]
        A, B = P0[cop], P1[cop]
        X = (A[:, None, :] + ts[None, :, None] * (B - A)[:, None, :]).reshape(-1, 3)
        if np.any(_strictly_inside(T, n, X, tol, open_edge)):
            return True
    return False


def _strictly_inside(T, n, X, tol, open_edge=None):
    """Points X (already near the plane) strictly inside triangle T. Edge
    ``open_edge`` (T[i] -> T[i+1]) counts as interior: a quad's diagonal."""
    inside = np.ones(len(X), dtype=bool)
    for i in range(3):
        a, b = T[i], T[(i + 1) % 3]
        inward = np.cross(n, b - a)
        inward /= np.linalg.norm(inward)
        inside &= (X - a) @ inward > (-tol if i == open_edge else tol)
    return inside


def _occupied(T, X, height, eps, open_edge=None):
    if len(X) == 0:
        return False
    n = _normal(*T)
    n = n / np.linalg.norm(n)
    size = max(np.linalg.norm(T[i] - T[(i + 1) % 3]) for i in range(3))
    h = height * size
    lo, hi = T.min(0) - h, T.max(0) + h
    X = X[np.all((X >= lo) & (X <= hi), 1)]
    if len(X) == 0:
        return False
    X = X[np.abs((X - T[0]) @ n) <= h]
    return bool(np.any(_strictly_inside(T, n, X, max(eps, 1e-4 * size), open_edge)))


def _orient(panels: list[Panel], xyz) -> list[Panel]:
    """Make neighbouring triangles agree in orientation, then point each
    connected patch outward (away from its centroid; +Z if it is flat)."""
    if not panels:
        return panels
    tris = [list(p.nodes) for p in panels]
    by_edge = defaultdict(list)
    for i, t in enumerate(tris):
        for k in range(3):
            by_edge[frozenset((t[k], t[(k + 1) % 3]))].append(i)

    def directed(t, a, b):
        return any(t[k] == a and t[(k + 1) % 3] == b for k in range(3))

    seen = [False] * len(tris)
    for start in range(len(tris)):
        if seen[start]:
            continue
        comp, q = [start], deque([start])
        seen[start] = True
        while q:
            i = q.popleft()
            t = tris[i]
            for k in range(3):
                a, b = t[k], t[(k + 1) % 3]
                nbrs = by_edge[frozenset((a, b))]
                if len(nbrs) != 2:
                    continue
                j = nbrs[0] if nbrs[1] == i else nbrs[1]
                if seen[j]:
                    continue
                if directed(tris[j], a, b):  # same direction -> flip neighbour
                    tris[j].reverse()
                seen[j] = True
                comp.append(j)
                q.append(j)
        cen = np.mean([xyz[n] for i in comp for n in tris[i]], axis=0)
        score, zsum = 0.0, 0.0
        for i in comp:
            P = [xyz[n] for n in tris[i]]
            nrm = _normal(*P)
            score += nrm @ (np.mean(P, axis=0) - cen)
            zsum += nrm[2]
        area = sum(np.linalg.norm(_normal(*(xyz[n] for n in tris[i]))) for i in comp)
        reach = max(np.linalg.norm(xyz[n] - cen) for i in comp for n in tris[i])
        flip = score < 0 if abs(score) > 1e-3 * area * reach else zsum < 0
        if flip:
            for i in comp:
                tris[i].reverse()
    return [Panel(tuple(t), p.origin) for t, p in zip(tris, panels)]
