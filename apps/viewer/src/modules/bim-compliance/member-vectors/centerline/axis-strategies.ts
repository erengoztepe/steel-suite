/**
 * Centerline strategies that read the member's **Axis/FootPrint** representation
 * (the cheapest, highest-confidence source — an explicit centerline curve):
 *   - IfcPolyline               → straight ("axis-polyline")
 *   - IfcTrimmedCurve / IfcLine → straight ("axis-line")
 *   - IfcTrimmedCurve / IfcCircle → circular arc ("axis-circle")
 * IfcMappedItem (type-shared geometry, common for columns) is unwrapped by
 * composing its MappingTarget and recursing.
 */

import {
  IFCCIRCLE,
  IFCLINE,
  IFCMAPPEDITEM,
  IFCPOLYLINE,
  IFCTRIMMEDCURVE,
  IfcAPI,
} from "web-ifc";

import {
  axis2placementMatrix,
  cartesianTransformMatrix,
  identity,
  line,
  type Mat4,
  multiply,
  normalize,
  num,
  ratios,
  str,
} from "../ifc-core";
import type { CenterlineCandidate, CircleAxisCurve } from "./types";

/** Resolve an IfcCartesianPoint or (fallback) a parametric point on a straight IfcLine. */
function resolveTrimPoint(api: IfcAPI, modelID: number, trimmedCurve: any, trimSelect: unknown): [number, number, number] | null {
  if (!Array.isArray(trimSelect) || trimSelect.length === 0) return null;
  const resolved = line(api, modelID, trimSelect[0]);
  if (resolved && Array.isArray(resolved.Coordinates)) {
    const c = ratios(resolved.Coordinates);
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  }
  // Parametric trim: only supported for a straight IfcLine basis curve (point = Pnt + u * Dir).
  const basis = line(api, modelID, trimmedCurve.BasisCurve);
  if (!basis || basis.type !== IFCLINE) return null;
  const pnt = line(api, modelID, basis.Pnt);
  const dirVec = line(api, modelID, basis.Dir);
  if (!pnt || !dirVec) return null;
  const p0 = ratios(pnt.Coordinates);
  const orientation = line(api, modelID, dirVec.Orientation);
  const dir = orientation ? normalize(ratios(orientation.DirectionRatios)) : [1, 0, 0];
  const magnitude = num(dirVec.Magnitude);
  const u = num(trimSelect[0]);
  return [
    (p0[0] ?? 0) + dir[0] * magnitude * u,
    (p0[1] ?? 0) + dir[1] * magnitude * u,
    (p0[2] ?? 0) + dir[2] * magnitude * u,
  ];
}

/**
 * Angle trim parameter (IfcParameterValue on a conic curve) → radians. Per the
 * IFC spec a circle/ellipse's parametric trim value is an angle in DEGREES,
 * independent of the project's plane-angle unit — confirmed against this
 * file's own data (Trim1≈77.8, Trim2≈102.8 for one arc; read as radians that
 * would be tens of full turns, nonsensical for a single trimmed segment).
 * Only the plain-value form is handled (mirrors `resolveTrimPoint`'s parametric
 * fallback) — a Cartesian-point trim on a circle is not resolved here.
 */
function trimAngleRad(trimSelect: unknown): number {
  if (!Array.isArray(trimSelect) || trimSelect.length === 0) return NaN;
  return (num(trimSelect[0]) * Math.PI) / 180;
}

/**
 * Resolve an IfcTrimmedCurve on an IfcCircle basis to a {@link CircleAxisCurve}
 * in the basis curve's own local frame (before `extraMatrix`/placement) — the
 * exact analytic centerline IFC already carries for a circular-arc member.
 */
function circleAxisCurve(api: IfcAPI, modelID: number, circle: any, trim1: unknown, trim2: unknown): CircleAxisCurve | null {
  const radius = num(circle.Radius);
  if (!(radius > 0)) return null;
  const theta1 = trimAngleRad(trim1);
  const theta2 = trimAngleRad(trim2);
  if (!Number.isFinite(theta1) || !Number.isFinite(theta2)) return null;

  // axis2placementMatrix's column convention (x=RefDirection⊥Axis, y=Axis×x,
  // z=Axis) is exactly IFC's P[0]/P[1] for a circle's parametric point.
  const posMatrix = axis2placementMatrix(api, modelID, line(api, modelID, circle.Position));
  const center: [number, number, number] = [posMatrix[3], posMatrix[7], posMatrix[11]];
  const xAxis: [number, number, number] = [posMatrix[0], posMatrix[4], posMatrix[8]];
  const yAxis: [number, number, number] = [posMatrix[1], posMatrix[5], posMatrix[9]];

  return { center, xAxis, yAxis, radius, theta1, theta2 };
}

/**
 * Recursively resolve a representation item to a centerline candidate. Handles
 * IfcPolyline, IfcTrimmedCurve on IfcLine (Cartesian + parametric trims) and on
 * IfcCircle (curved arc), and IfcMappedItem (composing MappingTarget). Returns
 * null for unsupported bases.
 */
function resolveAxisItem(api: IfcAPI, modelID: number, itemRef: unknown, extraMatrix: Mat4): CenterlineCandidate | null {
  const item = line(api, modelID, itemRef);
  if (!item) return null;

  if (item.type === IFCPOLYLINE) {
    if (!Array.isArray(item.Points) || item.Points.length < 2) return null;
    const first = line(api, modelID, item.Points[0]);
    const last = line(api, modelID, item.Points[item.Points.length - 1]);
    if (!first || !last) return null;
    const cs = ratios(first.Coordinates);
    const ce = ratios(last.Coordinates);
    return {
      source: "axis-polyline",
      usesMesh: false,
      localStart: [cs[0] ?? 0, cs[1] ?? 0, cs[2] ?? 0],
      localEnd: [ce[0] ?? 0, ce[1] ?? 0, ce[2] ?? 0],
      extraMatrix,
    };
  }

  if (item.type === IFCTRIMMEDCURVE) {
    const basis = line(api, modelID, item.BasisCurve);
    if (basis && basis.type === IFCCIRCLE) {
      const curve = circleAxisCurve(api, modelID, basis, item.Trim1, item.Trim2);
      if (curve) {
        const pointAt = (theta: number): [number, number, number] => [
          curve.center[0] + curve.radius * (Math.cos(theta) * curve.xAxis[0] + Math.sin(theta) * curve.yAxis[0]),
          curve.center[1] + curve.radius * (Math.cos(theta) * curve.xAxis[1] + Math.sin(theta) * curve.yAxis[1]),
          curve.center[2] + curve.radius * (Math.cos(theta) * curve.xAxis[2] + Math.sin(theta) * curve.yAxis[2]),
        ];
        return { source: "axis-circle", usesMesh: false, localStart: pointAt(curve.theta1), localEnd: pointAt(curve.theta2), extraMatrix, curve };
      }
    }
    if (!basis || basis.type !== IFCLINE) return null; // curved basis (unsupported kind) — not a straight member
    const start = resolveTrimPoint(api, modelID, item, item.Trim1);
    const end = resolveTrimPoint(api, modelID, item, item.Trim2);
    if (!start || !end) return null;
    return { source: "axis-line", usesMesh: false, localStart: start, localEnd: end, extraMatrix };
  }

  if (item.type === IFCMAPPEDITEM) {
    const mappingSource = line(api, modelID, item.MappingSource);
    if (!mappingSource) return null;
    const mappingTarget = cartesianTransformMatrix(api, modelID, item.MappingTarget);
    const mappedRep = line(api, modelID, mappingSource.MappedRepresentation);
    if (!mappedRep || !Array.isArray(mappedRep.Items)) return null;
    const composed = multiply(extraMatrix, mappingTarget);
    for (const innerRef of mappedRep.Items) {
      const resolved = resolveAxisItem(api, modelID, innerRef, composed);
      if (resolved) return resolved;
    }
    return null;
  }

  return null;
}

/**
 * Try every Axis/FootPrint representation item and return the first that
 * resolves to a centerline candidate (polyline / line / circle). null when the
 * member has no usable Axis representation.
 */
export function tryAxisStrategies(api: IfcAPI, modelID: number, element: any): CenterlineCandidate | null {
  const prodShape = line(api, modelID, element.Representation);
  if (!prodShape || !Array.isArray(prodShape.Representations)) return null;

  for (const repRef of prodShape.Representations) {
    const rep = line(api, modelID, repRef);
    if (!rep) continue;
    const ident = str(rep.RepresentationIdentifier);
    if (ident !== "Axis" && ident !== "FootPrint") continue;
    if (!Array.isArray(rep.Items)) continue;

    for (const itemRef of rep.Items) {
      const resolved = resolveAxisItem(api, modelID, itemRef, identity());
      if (resolved) return resolved;
    }
  }
  return null;
}
