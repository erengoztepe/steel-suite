import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "sap"))
from panel_finder import Options, find_panels  # noqa: E402


def grid(nx, ny, z=lambda x, y: 0.0, step=1.0):
    coords = {f"{i}_{j}": (i * step, j * step, z(i * step, j * step))
              for i in range(nx + 1) for j in range(ny + 1)}
    frames = [(f"{i}_{j}", f"{i+1}_{j}") for i in range(nx) for j in range(ny + 1)]
    frames += [(f"{i}_{j}", f"{i}_{j+1}") for i in range(nx + 1) for j in range(ny)]
    return coords, frames


def origins(res):
    return {frozenset(p.origin) for p in res.panels}


def test_quad_grid_splits_each_quad_in_two():
    coords, frames = grid(3, 2)
    res = find_panels(coords, frames)
    assert len(origins(res)) == 6
    assert len(res.panels) == 12


def test_triangulated_grid_keeps_triangles():
    coords, frames = grid(2, 2)
    frames += [(f"{i}_{j}", f"{i+1}_{j+1}") for i in range(2) for j in range(2)]
    res = find_panels(coords, frames)
    assert len(res.panels) == 8
    assert all(len(p.origin) == 3 for p in res.panels)


def test_x_braced_quad_without_centre_joint_is_one_quad():
    coords, frames = grid(1, 1)
    frames += [("0_0", "1_1"), ("1_0", "0_1")]
    res = find_panels(coords, frames)
    assert origins(res) == {frozenset(coords)}
    assert len(res.panels) == 2


def test_fan_on_curved_surface_does_not_add_outer_quad():
    coords = {"a": (0, 0, 0), "b": (2, 0, 0), "c": (2, 2, 0), "d": (0, 2, 0), "e": (1, 1, 0.3)}
    frames = [("a", "b"), ("b", "c"), ("c", "d"), ("d", "a")] + [(x, "e") for x in "abcd"]
    res = find_panels(coords, frames)
    assert len(res.panels) == 4
    assert all(len(p.origin) == 3 for p in res.panels)


def test_hole_larger_than_quad_stays_open():
    coords = {str(k): (np.cos(k * np.pi / 3), np.sin(k * np.pi / 3), 0) for k in range(6)}
    frames = [(str(k), str((k + 1) % 6)) for k in range(6)]
    assert find_panels(coords, frames).panels == []


def test_box_truss_faces_only_not_through_cuts():
    # 2-panel box: top and bottom chords, posts, no diagonals
    coords = {}
    for i in range(3):
        for y in (0, 1):
            for z in (0, 1):
                coords[f"{i}{y}{z}"] = (i, y, z)
    frames = []
    for y in (0, 1):
        for z in (0, 1):
            frames += [(f"0{y}{z}", f"1{y}{z}"), (f"1{y}{z}", f"2{y}{z}")]
    for i in range(3):
        frames += [(f"{i}00", f"{i}01"), (f"{i}01", f"{i}11"),
                   (f"{i}11", f"{i}10"), (f"{i}10", f"{i}00")]
    res = find_panels(coords, frames, opts=Options(skin_only=False))
    # 4 sides x 2 bays + 3 cross-frames; every 4-cycle here is a real face
    assert len(origins(res)) == 11
    # the outer skin drops the middle cross-frame, keeps the two end frames
    skin = find_panels(coords, frames)
    assert len(origins(skin)) == 10
    assert frozenset({"100", "101", "111", "110"}) not in origins(skin)


def test_dome_panels_point_outward_and_existing_are_skipped():
    coords, frames = grid(4, 4, z=lambda x, y: -0.1 * ((x - 2) ** 2 + (y - 2) ** 2))
    res = find_panels(coords, frames)
    assert len(res.panels) == 32
    for p in res.panels:
        P = np.array([coords[n] for n in p.nodes])
        assert np.cross(P[1] - P[0], P[2] - P[0])[2] > 0
    again = find_panels(coords, frames, existing=[p.nodes for p in res.panels])
    assert again.panels == [] and again.skipped_existing == 16


def test_warped_quad_rejected():
    coords = {"a": (0, 0, 0), "b": (1, 0, 0), "c": (1, 1, 1.5), "d": (0, 1, 0)}
    frames = [("a", "b"), ("b", "c"), ("c", "d"), ("d", "a")]
    res = find_panels(coords, frames)
    assert res.panels == [] and "warped" in res.rejected[0][1]

