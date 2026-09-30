"""Fill the gaps between frame members of the open SAP2000 model with area objects.

Attaches to the running SAP2000 instance (OAPI, ``pip install comtypes``),
finds the triangular / quadrilateral frame panels of the OUTER SKIN (see
``panel_finder.py``; ``--all-gaps`` for every panel) and adds one area per
triangle -- quads become two triangles.

    python tools/sap/fill_panels.py --dry-run            # report only
    python tools/sap/fill_panels.py --selected           # only the selected frames
    python tools/sap/fill_panels.py --prop ASEC1 --group NULL_FACADE

New areas get the null section "None" and go into a group (default NULL_FACADE) so they can be selected and
deleted in one go. Panels that already exist as areas are skipped, so the tool
can be re-run after editing the frame model.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_finder import Options, find_panels  # noqa: E402


def connect():
    import comtypes.client
    helper = comtypes.client.CreateObject("SAP2000v1.Helper")
    import comtypes.gen.SAP2000v1 as sap_api
    helper = helper.QueryInterface(sap_api.cHelper)
    try:
        sap = helper.GetObject("CSI.SAP2000.API.SapObject")
    except Exception:
        sap = None
    if sap is None:
        sys.exit("No running SAP2000 instance found - open the model in SAP2000 first.")
    return sap.SapModel


def read_model(model, selected_only: bool):
    _, frame_names, _ = model.FrameObj.GetNameList()
    frames = []
    for f in frame_names:
        if selected_only and not model.FrameObj.GetSelected(f, False)[0]:
            continue
        p1, p2, _ = model.FrameObj.GetPoints(f, "", "")
        frames.append((p1, p2))
    pts = {p for e in frames for p in e}
    coords = {p: tuple(model.PointObj.GetCoordCartesian(p, 0, 0, 0)[:3]) for p in pts}
    existing = []
    n, area_names, _ = model.AreaObj.GetNameList()
    for a in area_names[:n]:
        _, ap, _ = model.AreaObj.GetPoints(a, 0, [])
        existing.append(tuple(ap))
    return coords, frames, existing


def add_areas(model, panels, prop="None", group="NULL_FACADE"):
    """Add one triangular area per panel. ``prop`` "None" = SAP2000's built-in null
    area section (load transfer only; not listed by PropArea.GetNameList).
    Returns (added, failed, prop used)."""
    n_props, props, _ = model.PropArea.GetNameList()
    if prop != "None" and prop not in (props or ()):
        raise ValueError(f"Area section '{prop}' not defined. Defined: {', '.join(props)}")
    model.GroupDef.SetGroup(group)
    added = failed = 0
    for p in panels:
        out = model.AreaObj.AddByPoint(3, list(p.nodes), "", prop, "")
        name, ret = out[-2], out[-1]
        if ret != 0:
            failed += 1
            continue
        model.AreaObj.SetGroupAssign(name, group)
        added += 1
    model.View.RefreshView(0, False)
    return added, failed, prop


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report only, change nothing")
    ap.add_argument("--selected", action="store_true", help="use only the selected frames")
    ap.add_argument("--all-gaps", action="store_true",
                    help="fill every panel, not only the outer skin (truss interiors too)")
    ap.add_argument("--prop", default="None",
                    help="area section for the new areas (default: %(default)s, SAP2000's "
                         "built-in null section)")
    ap.add_argument("--group", default="NULL_FACADE", help="group for the new areas")
    ap.add_argument("--max-fold", type=float, default=Options.max_fold_deg,
                    help="max fold between the two halves of a quad, deg (default %(default)s)")
    ap.add_argument("--occupied-height", type=float, default=Options.occupied_height,
                    help="a joint within this x panel size of the panel plane, inside it, "
                         "rejects the panel (default %(default)s)")
    ap.add_argument("--unlock", action="store_true",
                    help="unlock a locked model (DELETES analysis results)")
    ap.add_argument("-v", "--verbose", action="store_true", help="list rejected cycles")
    args = ap.parse_args(argv)

    model = connect()
    print(f"Model: {model.GetModelFilename(True)}")
    coords, frames, existing = read_model(model, args.selected)
    print(f"Frames: {len(frames)}  joints: {len(coords)}  existing areas: {len(existing)}")
    if not frames:
        sys.exit("No frames to work on" + (" (nothing selected)." if args.selected else "."))

    res = find_panels(coords, frames, existing,
                      Options(max_fold_deg=args.max_fold, occupied_height=args.occupied_height,
                              skin_only=not args.all_gaps))
    n_tri = sum(1 for p in {p.origin for p in res.panels} if len(p) == 3)
    n_quad = sum(1 for p in {p.origin for p in res.panels} if len(p) == 4)
    print(f"Panels: {n_tri} triangles + {n_quad} quads -> {len(res.panels)} areas"
          f"  (already present: {res.skipped_existing}, rejected cycles: {len(res.rejected)})")
    if res.nonmanifold_edges:
        print(f"WARNING: {len(res.nonmanifold_edges)} frames border more than two panels "
              f"(surfaces meet there, check them): "
              + ", ".join("-".join(e) for e in res.nonmanifold_edges[:10])
              + (" ..." if len(res.nonmanifold_edges) > 10 else ""))
    if args.verbose:
        for cyc, why in res.rejected:
            print(f"  rejected {'-'.join(cyc)}: {why}")
    if args.dry_run or not res.panels:
        return

    if model.GetModelIsLocked():
        if not args.unlock:
            sys.exit("Model is locked (analysis results exist). Re-run with --unlock to "
                     "unlock it - this deletes the results.")
        model.SetModelIsLocked(False)

    try:
        added, failed, prop = add_areas(model, res.panels, args.prop, args.group)
    except ValueError as e:
        sys.exit(str(e))
    print(f"Added {added} areas (section '{prop}', group '{args.group}')"
          + (f", {failed} FAILED" if failed else ""))

if __name__ == "__main__":
    main()
