"""Unit tests for the ray-cast occlusion kernel (server/ifc_geom.py): box_mesh, RayOccluder,
clip_polyline, and the _point_in_mesh regression. These are pure-geometry tests (no IFC file
needed) so they can assert the exact behaviour the bolt-glyph clipping in views.ts depends on:
a segment through a plate must clip to the two visible runs outside it, never the portion
inside.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from ifc_geom import box_mesh, RayOccluder, clip_polyline, _point_in_mesh  # noqa: E402


def plate_box(half=(5.0, 50.0, 50.0)):
    """A 10mm-thick plate (x in [-5,5]) centred at the origin, as an occluder box."""
    return box_mesh((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), half)


def floor_box(half=(50.0, 50.0, 5.0)):
    """A 10mm-thick horizontal slab (z in [-5,5], wide in x,y) -- stands in for a flange seen
    from directly above (the PLAN view's use case: a web centreline running underneath it is
    hidden while under the flange's footprint, visible where it sticks out past the flange's
    own extent)."""
    return box_mesh((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), half)


def test_point_in_mesh_regression():
    verts, faces = plate_box()
    assert _point_in_mesh(np.array([0.0, 0.0, 0.0]), verts, faces) is True
    assert _point_in_mesh(np.array([100.0, 0.0, 0.0]), verts, faces) is False
    assert _point_in_mesh(np.array([4.9, 0.0, 0.0]), verts, faces) is True
    assert _point_in_mesh(np.array([5.1, 0.0, 0.0]), verts, faces) is False


def test_ray_occluder_hidden_points():
    verts, faces = plate_box()
    occ = RayOccluder([(verts, faces)])
    direction = (1.0, 0.0, 0.0)  # viewer is at +X looking back along -X
    pts = np.array([
        [10.0, 0.0, 0.0],   # in front of the plate (nearer the viewer) -> visible
        [0.0, 0.0, 0.0],    # inside the plate itself -> hidden (material at/after this point)
        [-10.0, 0.0, 0.0],  # behind the plate (viewer's ray must cross the plate) -> hidden
    ])
    hidden = occ.hidden(pts, direction)
    assert list(hidden) == [False, True, True]


def test_ray_occluder_no_occluders_never_hides():
    occ = RayOccluder([])
    pts = np.array([[0.0, 0.0, 0.0], [123.0, 45.0, 6.0]])
    assert not occ.hidden(pts, (1.0, 0.0, 0.0)).any()


def test_clip_polyline_segment_removes_buried_span():
    """A web centreline running along X at y=0 under a 100mm-wide flange slab (x,y in
    [-50,50], z in [-5,5]), viewed from directly above (direction=+Z): the portion under the
    flange's FOOTPRINT must be clipped away, leaving two visible runs where it sticks out past
    the flange -- exactly the PLAN view's dashed-web-under-flange case."""
    verts, faces = floor_box()
    occ = RayOccluder([(verts, faces)])
    line = [(-80.0, 0.0, 0.0), (80.0, 0.0, 0.0)]
    runs = clip_polyline(line, closed=False, occluder=occ, direction=(0.0, 0.0, 1.0))
    assert len(runs) == 2
    xs = sorted(pt[0] for run in runs for pt in (run[0], run[-1]))
    # outer endpoints preserved; inner (clipped) endpoints land within ~1mm of the flange edge
    assert xs[0] == pytest.approx(-80.0, abs=1e-2)
    assert xs[-1] == pytest.approx(80.0, abs=1e-2)
    inner = sorted(x for x in xs if -79 < x < 79)
    assert inner[0] == pytest.approx(-50.0, abs=0.5)
    assert inner[1] == pytest.approx(50.0, abs=0.5)


def test_clip_polyline_fully_hidden_segment_is_dropped():
    verts, faces = plate_box()
    occ = RayOccluder([(verts, faces)])
    line = [(-3.0, 3.0, 0.0), (3.0, 3.0, 0.0)]  # entirely inside the plate's x-span
    runs = clip_polyline(line, closed=False, occluder=occ, direction=(1.0, 0.0, 0.0))
    assert runs == []


def test_clip_polyline_fully_visible_segment_is_kept_whole():
    verts, faces = plate_box()
    occ = RayOccluder([(verts, faces)])
    line = [(20.0, 3.0, 0.0), (40.0, 3.0, 0.0)]  # entirely clear of the plate
    runs = clip_polyline(line, closed=False, occluder=occ, direction=(1.0, 0.0, 0.0))
    assert len(runs) == 1
    assert runs[0][0][0] == pytest.approx(20.0, abs=1e-2)
    assert runs[0][-1][0] == pytest.approx(40.0, abs=1e-2)


def test_clip_polyline_whole_mode_all_or_nothing():
    verts, faces = plate_box()
    occ = RayOccluder([(verts, faces)])
    # a closed hex-ish loop straddling the plate: mostly hidden -> dropped entirely
    loop = [(-1.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 2.0, 0.0), (-1.0, 2.0, 0.0)]
    runs = clip_polyline(loop, closed=True, occluder=occ, direction=(1.0, 0.0, 0.0), mode="whole")
    assert runs == []
    clear_loop = [(20.0, 0.0, 0.0), (22.0, 0.0, 0.0), (22.0, 2.0, 0.0), (20.0, 2.0, 0.0)]
    runs2 = clip_polyline(clear_loop, closed=True, occluder=occ, direction=(1.0, 0.0, 0.0), mode="whole")
    assert len(runs2) == 1
