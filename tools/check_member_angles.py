"""Check that no two members meeting at a node are closer than a minimum angle.

    python tools/check_member_angles.py <model.ifc> [--min 30]

Works on member centrelines: each element's Axis representation (or, without one, its
extrusion along the placement's Z). A node is any member end; members whose axis passes
THROUGH a node (a continuous post carrying a secondary chord, say) count there too, in both
directions. Collinear continuations (~180 degrees) are fine; everything below --min is listed.
Exit code 1 if any pair is too close.
"""
from __future__ import annotations

import argparse
import itertools
import math
import sys
from collections import defaultdict

import ifcopenshell
import ifcopenshell.util.placement as up
import numpy as np


def centrelines(f):
    for e in f.by_type("IfcElement"):
        if not e.Representation or not e.ObjectPlacement:
            continue
        M = up.get_local_placement(e.ObjectPlacement)
        axis = next((r for r in e.Representation.Representations if r.RepresentationIdentifier == "Axis"), None)
        if axis is not None and axis.Items[0].is_a("IfcPolyline"):
            pts = [np.array(list(p.Coordinates) + [0.0] * (3 - len(p.Coordinates))) for p in axis.Items[0].Points]
            a, b = pts[0], pts[-1]
        else:
            solid = next((i for r in e.Representation.Representations for i in r.Items
                          if i.is_a("IfcExtrudedAreaSolid")), None)
            if solid is None:
                continue
            a, b = np.zeros(3), np.array([0.0, 0.0, solid.Depth])
        wa = M[:3, :3] @ a + M[:3, 3]
        wb = M[:3, :3] @ b + M[:3, 3]
        yield e.Tag or e.GlobalId, wa, wb


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ifc")
    ap.add_argument("--min", type=float, default=30.0, help="minimum angle in degrees")
    ap.add_argument("--tol", type=float, default=1.0, help="node tolerance in model units")
    args = ap.parse_args()

    f = ifcopenshell.open(args.ifc)
    segs = list(centrelines(f))
    tags = [s[0] for s in segs]
    A = np.array([s[1] for s in segs]); B = np.array([s[2] for s in segs])
    D = B - A; LL = np.einsum("ij,ij->i", D, D)

    nodes: dict = defaultdict(list)          # node key -> [(member index, outward unit dir)]
    for i in range(len(segs)):
        for p, q in ((A[i], B[i]), (B[i], A[i])):
            k = tuple(np.round(p / args.tol).astype(int))
            nodes[k].append((i, (q - p) / np.linalg.norm(q - p), p))

    worst, bad = 180.0, []
    for k, inc in nodes.items():
        p = inc[0][2]
        # members passing through this node
        t = np.einsum("ij,ij->i", p - A, D) / LL
        close = np.linalg.norm(A + D * t[:, None] - p, axis=1) < args.tol
        through = np.where(close & (t > 1e-6) & (t < 1 - 1e-6))[0]
        dirs = [(i, d) for i, d, _ in inc]
        for i in through:
            u = D[i] / math.sqrt(LL[i])
            dirs += [(i, u), (i, -u)]
        for (i, u), (j, v) in itertools.combinations(dirs, 2):
            if i == j:
                continue
            ang = math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(u, v))))))
            worst = min(worst, ang)
            if ang < args.min:
                bad.append((ang, tags[i], tags[j], np.round(p, 0)))

    print(f"{len(segs)} members, {len(nodes)} end nodes; smallest angle between two members "
          f"meeting at a node: {worst:.1f} deg")
    if bad:
        bad.sort()
        print(f"{len(bad)} pair(s) below {args.min:g} deg:")
        for ang, a, b, p in bad[:40]:
            print(f"  {ang:5.1f} deg  {a}  /  {b}  at {p.tolist()}")
        return 1
    print(f"OK: no pair below {args.min:g} deg")
    return 0


if __name__ == "__main__":
    sys.exit(main())
