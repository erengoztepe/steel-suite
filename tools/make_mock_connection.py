"""Generate the viewer's SYNTHETIC mock connection model.

    python tools/make_mock_connection.py [out.ifc]

Writes apps/viewer/public/models/mock_connection.ifc by default. The connection-design panel
loads it when the IDEA StatiCa REST API is not reachable, so the UI can be exercised offline.

Everything here is made up from catalogue shapes -- it is NOT taken from any real project:
a main beam, a secondary beam framing into its web through a fin plate, and three bolts.
Same conventions as an IDEA StatiCa connection export: IFC2X3, SI metres, the connection
node at the origin (the viewer translates the model onto the real node itself).
"""
from __future__ import annotations

import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.api as api
import ifcopenshell.guid

OUT = Path(__file__).resolve().parent.parent / "apps/viewer/public/models/mock_connection.ifc"


def main(out: Path) -> None:
    f = api.run("project.create_file", version="IFC2X3")
    # IFC2X3 needs an OwnerHistory on every rooted entity; credit the generator, not a person
    import ifcopenshell.api.owner.settings as owner_settings
    person = f.createIfcPerson(None, "steel-suite", None, None, None, None, None, None)
    org = f.createIfcOrganization(None, "steel-suite", None, None, None)
    user = f.createIfcPersonAndOrganization(person, org, None)
    app = f.createIfcApplication(org, "1.0", "steel-suite mock generator", "steel-suite")
    owner_settings.get_user = lambda _f: user
    owner_settings.get_application = lambda _f: app
    project = api.run("root.create_entity", f, ifc_class="IfcProject", name="Mock connection")
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METRE"})
    ctx = api.run("context.add_context", f, context_type="Model")
    body = api.run("context.add_context", f, context_type="Model", context_identifier="Body",
                   target_view="MODEL_VIEW", parent=ctx)
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Building")
    api.run("aggregate.assign_object", f, relating_object=project, products=[site])
    api.run("aggregate.assign_object", f, relating_object=site, products=[building])

    def place(prod, origin, axis, ref):
        """Local placement: `axis` = local Z (extrusion direction), `ref` = local X."""
        o = f.createIfcCartesianPoint([float(v) for v in origin])
        z = f.createIfcDirection([float(v) for v in axis])
        x = f.createIfcDirection([float(v) for v in ref])
        prod.ObjectPlacement = f.createIfcLocalPlacement(None, f.createIfcAxis2Placement3D(o, z, x))

    def extrude(prod, profile, depth):
        solid = f.createIfcExtrudedAreaSolid(
            profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, 0.0]), None, None),
            f.createIfcDirection([0.0, 0.0, 1.0]), float(depth))
        rep = f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])
        prod.Representation = f.createIfcProductDefinitionShape(None, None, [rep])

    def pos2d():   # IFC2X3 profiles need an explicit (identity) 2D position
        return f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, 0.0]), None)

    def i_profile(name, b, h, tw, tf, r):
        return f.createIfcIShapeProfileDef("AREA", name, pos2d(), b, h, tw, tf, r)

    def element(cls, name, tag):
        e = api.run("root.create_entity", f, ifc_class=cls, name=name)
        e.Tag = tag
        api.run("spatial.assign_container", f, relating_structure=building, products=[e])
        return e

    # Local frames: `axis` is the extrusion direction; `ref` is chosen so the profile's own Y
    # (the section depth) ends up vertical: axis x ref = global +Z.
    tw_main, tw_sec = 0.0085, 0.0062
    web_face = tw_main / 2                      # +Y face of the main beam's web

    # main beam along global X, top of steel at z = 0; the node is the origin
    main_h = 0.300
    zc = -main_h / 2                            # both beams share this centreline height
    main = element("IfcBeam", "HEA300", "MB-1")
    place(main, (-1.0, 0.0, zc), (1, 0, 0), (0, 1, 0))
    extrude(main, i_profile("HEA300", 0.300, main_h, tw_main, 0.014, 0.027), 2.0)

    # secondary beam along global Y, framing in from +Y, 15 mm clear of the main web; it sits
    # between the main beam's flanges (240 < 300 - 2 x 14), so no cope is needed
    sec = element("IfcBeam", "IPE240", "SB-1")
    place(sec, (0.0, web_face + 0.015, zc), (0, 1, 0), (-1, 0, 0))
    extrude(sec, i_profile("IPE240", 0.120, 0.240, tw_sec, 0.0098, 0.015), 1.5)

    # fin plate: parallel to the secondary web (normal X), welded along its edge to the main web
    # face, lapping the secondary web on its +X side
    pl_t, pl_w, pl_h = 0.010, 0.110, 0.180
    plate = element("IfcPlate", "PL10", "FP-1")
    place(plate, (tw_sec / 2 + pl_t / 2, web_face + pl_w / 2, zc), (1, 0, 0), (0, 1, 0))
    rect = f.createIfcRectangleProfileDef("AREA", "PL10", pos2d(), pl_w, pl_h)
    solid = f.createIfcExtrudedAreaSolid(      # centred on the plate's mid-plane
        rect, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint([0.0, 0.0, -pl_t / 2]), None, None),
        f.createIfcDirection([0.0, 0.0, 1.0]), pl_t)
    plate.Representation = f.createIfcProductDefinitionShape(
        None, None, [f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [solid])])

    # three M20 bolts along X through secondary web + plate, 70 mm pitch
    for i, dz in enumerate((-0.070, 0.0, 0.070)):
        bolt = element("IfcMechanicalFastener", "M20 8.8", f"B-{i + 1}")
        place(bolt, (-0.025, web_face + 0.070, zc + dz), (1, 0, 0), (0, 1, 0))
        extrude(bolt, f.createIfcCircleProfileDef("AREA", "M20", pos2d(), 0.010), 0.050)

    out.parent.mkdir(parents=True, exist_ok=True)
    f.write(str(out))
    print(f"wrote {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
