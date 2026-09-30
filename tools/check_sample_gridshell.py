"""Check the sample gridshell written by tools/make_sample_gridshell.py.

    python tools/check_sample_gridshell.py [model.ifc]

Prints one line per check and exits 1 if any fails:
  * connectivity -- no free member end except on the ground (supports), no member lying in
    the ground plane, no two centrelines crossing away from a node (< 50 mm apart);
  * sizes -- lattice (non-diagrid) members >= 1.5 m, nothing > 6 m;
  * sections by role -- girder / rib / box chords and every post: I; ring truss chords
    (and the girder struts that carry them on) and door frames: RHS; everything else: CHS;
  * lattice rule -- opposite faces in phase (left = right side face, top = bottom face) and
    the lattice a mirror image across both plan axes (G1<->G2<->G4<->G3, R1<->R3, R2<->R4);
  * geometry -- every member has a body.
The angle rule (>= 30 deg at every node) is tools/check_member_angles.py.
"""
from __future__ import annotations

import collections
import math
import multiprocessing
import re
import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement
import numpy as np

DEFAULT = Path(__file__).resolve().parent.parent / "apps/viewer/public/models/sample_gridshell.ifc"
MIN_LATTICE, MAX_MEMBER, CLASH = 1.5, 6.0, 0.05
RING_CHORD = re.compile(r"^(TOPGRID|CROWNO|CROWNI)-([TB]C\d+|[GR]\d[TB])$")
CHORD = re.compile(r"^([GR]\d[LR]-[TB]C\d+|X\d[LR][TB]C\d)$")
POST = re.compile(r"-V\d+$")


def load(path):
    f = ifcopenshell.open(str(path))
    seg, prof = {}, {}
    for e in f.by_type("IfcElement"):
        m = ifcopenshell.util.placement.get_local_placement(e.ObjectPlacement)
        length = e.Representation.Representations[0].Items[0].Points[-1].Coordinates[2]
        seg[e.Tag] = (m[:3, 3] / 1000, (m[:3, 3] + m[:3, 2] * length) / 1000)
        prof[e.Tag] = e.Representation.Representations[1].Items[0].SweptArea.is_a()
    return f, seg, prof


def main(path: Path) -> int:
    f, seg, prof = load(path)
    tags = list(seg)
    A = np.array([seg[t][0] for t in tags]); B = np.array([seg[t][1] for t in tags])
    D = B - A; LL = np.einsum("ij,ij->i", D, D)
    key = lambda p: tuple(np.round(p, 3))
    ok = True

    def report(name, good, detail):
        nonlocal ok
        ok &= bool(good)
        print(f"{'OK  ' if good else 'FAIL'} {name}: {detail}")

    # ---- connectivity
    ends = collections.Counter(key(p) for t in tags for p in seg[t])
    free = []
    for k, c in ends.items():
        if c > 1 or abs(k[2]) < 1e-6:
            continue
        p = np.array(k); s = np.clip(np.einsum("ij,ij->i", p - A, D) / LL, 0, 1)
        d = np.linalg.norm(A + D * s[:, None] - p, axis=1)
        if np.sum(d < 1e-3) < 2:                       # only its own member reaches it
            free.append(k)
    flat = [t for t in tags if abs(seg[t][0][2]) < 1e-6 and abs(seg[t][1][2]) < 1e-6]
    report("connectivity", not free and not flat,
           f"{len(tags)} members, {len(ends)} nodes, {sum(1 for k in ends if abs(k[2]) < 1e-6)} on the ground "
           f"(supports); free ends {len(free)}, members in the ground plane {len(flat)}")
    lo, hi = np.minimum(A, B) - CLASH, np.maximum(A, B) + CLASH
    clashes = []
    for i in range(len(tags)):
        cand = np.where(np.all(lo <= hi[i], axis=1) & np.all(hi >= lo[i], axis=1))[0]
        for j in cand[cand > i]:
            if {key(A[i]), key(B[i])} & {key(A[j]), key(B[j])}:
                continue
            d1, d2, r = D[i], D[j], A[i] - A[j]
            a, e, b, c, f_ = d1 @ d1, d2 @ d2, d1 @ d2, d1 @ r, d2 @ r
            den = a * e - b * b
            s = np.clip((b * f_ - c * e) / den, 0, 1) if den > 1e-12 else 0.0
            t = np.clip((b * s + f_) / e, 0, 1); s = np.clip((b * t - c) / a, 0, 1)
            if np.linalg.norm(A[i] + d1 * s - A[j] - d2 * t) < CLASH and 1e-3 < s < 1 - 1e-3 and 1e-3 < t < 1 - 1e-3:
                clashes.append((tags[i], tags[j]))
    report("clashes", not clashes, f"{len(clashes)} centreline pairs closer than {CLASH * 1000:.0f} mm away from a node {clashes[:4]}")

    # ---- sizes
    L = {t: float(np.linalg.norm(seg[t][1] - seg[t][0])) for t in tags}
    lattice = {t: l for t, l in L.items() if not t.startswith("DG")}
    short = min(lattice, key=lattice.get); long_ = max(L, key=L.get)
    report("sizes", lattice[short] >= MIN_LATTICE and L[long_] <= MAX_MEMBER,
           f"shortest lattice member {lattice[short]:.3f} m ({short}), longest member {L[long_]:.2f} m ({long_})")

    # ---- sections by role
    def want(t):
        if RING_CHORD.match(t) or t.startswith("DOOR"):
            return "IfcRectangleHollowProfileDef"
        return "IfcIShapeProfileDef" if CHORD.match(t) or POST.search(t) else "IfcCircleHollowProfileDef"
    bad = [(t, prof[t]) for t in tags if prof[t] != want(t)]
    count = collections.Counter(want(t)[3:-10] for t in tags)
    report("sections by role", not bad, f"{dict(count)}; wrong {len(bad)} {bad[:4]}")

    # ---- lattice rule: opposite faces in phase
    def chain(prefix):
        i, pts = 1, []
        while f"{prefix}{i:02d}" in seg:
            a, b = seg[f"{prefix}{i:02d}"]
            pts = pts or [a]; pts.append(b); i += 1
        return pts
    arms = sorted({m.group(1) for t in tags if (m := re.match(r"^([GR]\d)[LR]-TC01$", t))})
    phase_bad = []
    for arm in arms:
        C = {n: chain(f"{arm}{s}-{c}C") for n, s, c in (("TL", "L", "T"), ("TR", "R", "T"), ("BL", "L", "B"), ("BR", "R", "B"))}
        idx = {key(p): (n, i) for n, P in C.items() for i, p in enumerate(P)}
        side = {s: [idx[key(seg[f"{arm}{s}-D{i + 1:02d}"][0])][0][0] for i in range(len(C["TL"]) - 1)] for s in "LR"}
        if side["L"] != side["R"]:                           # starts on T or B, panel by panel
            phase_bad.append(f"{arm} side faces")
        start = {lvl: idx[key(seg[f"{arm}-{lvl}D01"][0])][0][1] for lvl in "TB"}
        if start["T"] != start["B"]:
            phase_bad.append(f"{arm} top/bottom faces")
    # ---- lattice rule: mirror symmetry across both plan axes
    def pairs(prefix):
        return {t[len(prefix):]: frozenset((key(seg[t][0]), key(seg[t][1]))) for t in tags
                if t.startswith(prefix) and not t.startswith(prefix + "0")}
    def mapped(src, fn):
        return {k: frozenset(key(fn(np.array(p))) for p in v) for k, v in src.items()}
    mx = lambda p: p * np.array([-1, 1, 1]); my = lambda p: p * np.array([1, -1, 1]); rz = lambda p: p * np.array([-1, -1, 1])
    sym_bad = []
    for a, b, fn in (("G1", "G2", mx), ("G1", "G4", my), ("G1", "G3", rz), ("R1", "R3", mx), ("R2", "R4", my)):
        pa, pb = mapped(pairs(a), fn), pairs(b)
        if set(pa.values()) != set(pb.values()):
            sym_bad.append(f"{a}->{b}: {len(set(pa.values()) ^ set(pb.values()))} members differ")
    report("lattice rule", not phase_bad and not sym_bad,
           f"{len(arms)} girders/ribs; opposite faces out of phase: {phase_bad or 'none'}; mirror symmetry: {sym_bad or 'holds'}")

    # ---- geometry
    it = ifcopenshell.geom.iterator(ifcopenshell.geom.settings(), f, multiprocessing.cpu_count())
    it.initialize(); n = empty = 0
    while True:
        n += 1; empty += len(it.get().geometry.verts) == 0
        if not it.next():
            break
    report("geometry", empty == 0 and n == len(tags), f"{n} shapes, {empty} empty")
    P = np.vstack([A, B]); base = P[np.abs(P[:, 2]) < 1e-6]
    w = [np.ptp(base[:, :2] @ np.array([math.cos(math.radians(d)), math.sin(math.radians(d))])) for d in np.arange(0, 180, 0.25)]
    print(f"     size: {max(w):.2f} x {min(w):.2f} m footprint, {P[:, 2].max():.2f} m high")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT))
