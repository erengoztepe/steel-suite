"""Cover the outer facade of a SAP2000 .sdb file with null ("None") areas, file in -> file out.

Backend of the web page's "Null Facade" tab. SAP2000 is licensed per seat, so a second
(hidden) instance cannot be started next to a running one: the file is opened in the
RUNNING SAP2000 window (started if there is none). Whatever model that window had is
closed WITHOUT saving and reopened from disk afterwards.

    python tools/sap/fill_sdb.py in.sdb out.sdb [--prop None] [--all-gaps]
                                 [--preview out.png]

Prints one JSON object on stdout ({"error": ...} on failure).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fill_panels import add_areas, read_model  # noqa: E402
from panel_finder import Options, find_panels  # noqa: E402


def sap_model():
    """The running SAP2000's model, starting SAP2000 if none is running."""
    import comtypes.client
    helper = comtypes.client.CreateObject("SAP2000v1.Helper")
    import comtypes.gen.SAP2000v1 as sap_api
    helper = helper.QueryInterface(sap_api.cHelper)
    try:
        sap = helper.GetObject("CSI.SAP2000.API.SapObject")
    except Exception:
        sap = None
    if sap is None:
        sap = helper.CreateObjectProgID("CSI.SAP2000.API.SapObject")
        if sap.ApplicationStart(9, True, "") != 0:  # 9 = N, mm, C
            raise RuntimeError("could not start SAP2000")
    return sap.SapModel


def preview(path, coords, frames, panels):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection

    xs, ys, zs = zip(*coords.values())
    fig = plt.figure(figsize=(14, 6.5))
    for k, (el, az) in enumerate([(25, -60), (10, 30)]):
        ax = fig.add_subplot(1, 2, k + 1, projection="3d")
        ax.add_collection3d(Line3DCollection([[coords[a], coords[b]] for a, b in frames],
                                             colors="#2040c0", linewidths=0.4))
        ax.add_collection3d(Poly3DCollection([[coords[n] for n in p.nodes] for p in panels],
                                             facecolors="#ff80ff", edgecolors="#800030",
                                             linewidths=0.2, alpha=0.9))
        ax.set_xlim(min(xs), max(xs))
        ax.set_ylim(min(ys), max(ys))
        ax.set_zlim(min(zs), max(zs))
        ax.set_box_aspect((max(xs) - min(xs) or 1, max(ys) - min(ys) or 1,
                           max(zs) - min(zs) or 1))
        ax.view_init(el, az)
        ax.set_axis_off()
    plt.tight_layout()
    plt.savefig(path, dpi=100)
    plt.close(fig)


def run(args):
    src, dst = Path(args.input).resolve(), Path(args.output).resolve()
    # SAP writes its sidecar files next to the model: work on a copy in dst's folder
    work = dst.with_name(dst.stem + "_work.sdb")
    shutil.copyfile(src, work)

    model = sap_model()
    previous = model.GetModelFilename(True) or ""
    if not Path(previous).is_file():  # "(Untitled)" or a deleted file
        previous = ""
    try:
        if model.File.OpenFile(str(work)) != 0:
            raise RuntimeError("SAP2000 could not open the file")
        coords, frames, existing = read_model(model, False)
        if not frames:
            raise RuntimeError("the model has no frames")
        res = find_panels(coords, frames, existing, Options(skin_only=not args.all_gaps))
        origins = {p.origin for p in res.panels}
        was_locked = bool(model.GetModelIsLocked())
        if was_locked:
            model.SetModelIsLocked(False)  # drops analysis results
        added, failed, prop = add_areas(model, res.panels, args.prop, args.group)
        if model.File.Save(str(dst)) != 0:
            raise RuntimeError("SAP2000 could not save the result")
        if args.preview:
            preview(args.preview, coords, frames, res.panels)
        return {
            "frames": len(frames),
            "joints": len(coords),
            "existingAreas": len(existing),
            "triangles": sum(1 for o in origins if len(o) == 3),
            "quads": sum(1 for o in origins if len(o) == 4),
            "added": added,
            "failed": failed,
            "alreadyPresent": res.skipped_existing,
            "rejected": len(res.rejected),
            "nonManifoldFrames": len(res.nonmanifold_edges),
            "section": prop,
            "group": args.group,
            "unlocked": was_locked,
            "reopened": previous,
        }
    finally:
        if previous:
            model.File.OpenFile(previous)
        else:
            model.InitializeNewModel(9)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--prop", default="None")
    ap.add_argument("--group", default="NULL_FACADE")
    ap.add_argument("--all-gaps", action="store_true")
    ap.add_argument("--preview", default=None)
    args = ap.parse_args(argv)
    try:
        out = run(args)
    except Exception as e:  # reported to the web page, not a traceback
        out = {"error": str(e)}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
