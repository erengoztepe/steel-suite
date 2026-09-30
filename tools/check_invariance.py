"""Rotation-invariance test: the SAME connection fed at an arbitrary orientation must produce
the SAME drawing. Compares the rotation-invariant part of the signature (entity counts, sorted
dimension values, arc radii) between the baseline and a rotated build. A difference means some
step depends on global axes rather than on features -- the latent bug two passing examples
can't catch on their own (pipeline-doctrine section 5).

Usage: python tools/check_invariance.py <baseline.dxf> <rotated.dxf>
Exit 0 = invariant, 1 = differs.
"""
from __future__ import annotations
import sys
from pathlib import Path

import ezdxf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_drawing as V


def invariant_sig(dxf: str) -> dict:
    msp = ezdxf.readfile(dxf).modelspace()
    full = V.signature(msp, sorted(round(float(d.get_measurement()), 1) for d in msp.query("DIMENSION")), {})
    # drop the pieces that legitimately change under rotation (bbox size); keep the invariants
    return {k: full[k] for k in ("entities_by_layer", "entities_by_type", "dim_values", "arc_radii")}


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    base, rot = invariant_sig(argv[1]), invariant_sig(argv[2])
    diffs = [f"{k}: {base[k]!r} != {rot[k]!r}" for k in base if base[k] != rot[k]]
    if diffs:
        print("  FAIL rotation invariance (output depends on global axes):")
        for d in diffs:
            print(f"       {d}")
        return 1
    print("  ok   rotation invariant (drawing unchanged under a 37 deg oblique input rotation)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
