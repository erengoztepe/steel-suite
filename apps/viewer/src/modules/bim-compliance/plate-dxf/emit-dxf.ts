/**
 * Emit a minimal ASCII DXF for a flat plate's cut outline: one closed
 * polyline for the outer contour, one per hole. No external DXF library —
 * group-code text is simple enough for this closed-polygon-only case, and it
 * avoids taking on a new dependency for it.
 *
 * Targets R12 (AC1009) with legacy POLYLINE/VERTEX/SEQEND rather than
 * R2000's LWPOLYLINE: an R2000+ LWPOLYLINE requires `100/AcDbEntity` +
 * `100/AcDbPolyline` subclass markers (and, strictly, entity handles) or
 * real AutoCAD refuses to open the file ("missing AcDbPolyline subclass",
 * confirmed via ezdxf against a first draft that omitted them) — R12 has no
 * such requirement and is universally read by CAD/CAM/laser-cutting software.
 *
 * Outer and hole loops come from `extractPlateOutline` wound opposite to each
 * other (the sign CAM/nesting software uses to recognize holes), already
 * oriented so DXF +Y is the plate's global "up" (+Z).
 */

import type { PlateOutline } from "./extract-plate-outline";
import { requireSurface } from "../member-vectors/doc-metrics";

function num(n: number): string {
  return (Math.round(n * 1e4) / 1e4).toString();
}

function polyline(points: [number, number][], layer: string): string[] {
  const lines = ["0", "POLYLINE", "8", layer, "66", "1", "70", "1"];
  for (const [x, y] of points) lines.push("0", "VERTEX", "8", layer, "10", num(x), "20", num(y));
  lines.push("0", "SEQEND");
  return lines;
}

export function emitPlateDxf(outline: Pick<PlateOutline, "outerMm" | "holesMm">): string {
  requireSurface();
  const lines: string[] = [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    "0", "ENDSEC",

    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER", "70", "2",
    "0", "LAYER", "2", "OUTLINE", "70", "0", "62", "7", "6", "CONTINUOUS",
    "0", "LAYER", "2", "HOLES", "70", "0", "62", "1", "6", "CONTINUOUS",
    "0", "ENDTAB",
    "0", "ENDSEC",

    "0", "SECTION", "2", "ENTITIES",
    ...polyline(outline.outerMm, "OUTLINE"),
  ];
  for (const hole of outline.holesMm) lines.push(...polyline(hole, "HOLES"));
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n") + "\n";
}
