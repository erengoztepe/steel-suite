/**
 * Browser-native port of Eren's `vektorcek.txt` IfcOpenShell script —
 * ORCHESTRATION layer.
 *
 * For an ordered list of beam/column GlobalIds it computes, per member:
 *   - the centerline (start/end, or a circular arc) via the centerline resolver
 *     (`centerline/resolver.ts`), which picks among several extraction strategies
 *     and cross-checks them — see that file for the geometry;
 *   - direction vector, unit vector, length;
 *   - the cross-section (local X/Y/Z) frame + IDEA-convention rotation;
 *   - profile (cross-section) and material names + structural psets when resolvable.
 *
 * Low-level web-ifc + matrix helpers live in `ifc-core.ts`. This file keeps only
 * the beam/column-specific work: property sets, profiles/materials, the rotation
 * frame, and assembling the output rows.
 */

import {
  IfcAPI,
  IFCBEAM,
  IFCBOOLEANCLIPPINGRESULT,
  IFCBOOLEANRESULT,
  IFCCIRCLEPROFILEDEF,
  IFCCOLUMN,
  IFCISHAPEPROFILEDEF,
  IFCMAPPEDITEM,
  IFCMEMBER,
  IFCRECTANGLEPROFILEDEF,
  IFCRELASSOCIATESMATERIAL,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELDEFINESBYTYPE,
} from "web-ifc";

import {
  cross,
  GLOBAL_UP,
  handleId,
  line,
  normalize,
  num,
  ratios,
  str,
  WASM_PATH,
} from "./ifc-core";
import { resolveCenterline } from "./centerline/resolver";
import type { MemberVectorRow } from "./types";

// Re-exported so existing importers (e.g. plate-dxf) keep a single entry point.
export { WASM_PATH } from "./ifc-core";
export type { Mat4 } from "./ifc-core";
export {
  cartesianTransformMatrix,
  cross,
  identity,
  line,
  multiply,
  normalize,
  ratios,
  str,
  transformPoint,
} from "./ifc-core";

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Reference horizontal direction for "rotation = 0" — mirrors IDEA StatiCa's
 * convention (Eren's `referans_dik_vektor`): for a non-vertical member the
 * reference is cross(up, axis). For a VERTICAL member (column), IDEA's own rule
 * is to use global Y DIRECTLY as the reference — not a cross product with a
 * helper vector.
 */
function referencePerp(axis: number[]): number[] {
  const a = normalize(axis);
  if (Math.abs(dot3(a, GLOBAL_UP)) > 0.999) return [0, 1, 0];
  return normalize(cross(GLOBAL_UP, a));
}

/**
 * Signed angle (degrees) about `axis`, right-hand rule, from `ref` to `vec`
 * (both projected perpendicular to `axis`). Matches IDEA's RotationRx (Eren's
 * `imzali_aci_derece`).
 */
function signedAngleDeg(axis: number[], ref: number[], vec: number[]): number {
  const a = normalize(axis);
  const perp = (v: number[]) => {
    const p = [v[0] - dot3(v, a) * a[0], v[1] - dot3(v, a) * a[1], v[2] - dot3(v, a) * a[2]];
    return normalize(p);
  };
  const r = perp(ref);
  const g = perp(vec);
  const s = dot3(cross(r, g), a);
  const c = dot3(r, g);
  return (Math.atan2(s, c) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Property sets (via IfcRelDefinesByProperties)
// ---------------------------------------------------------------------------

/** elementExpressId → { psetName → { propName → value } } */
type PsetMap = Map<number, Record<string, Record<string, unknown>>>;

function ids(api: IfcAPI, modelID: number, type: number): number[] {
  try {
    const r = api.GetLineIDsWithType(modelID, type) as any;
    if (Array.isArray(r)) return r;
    const out: number[] = [];
    for (let i = 0; i < r.size(); i++) out.push(r.get(i));
    return out;
  } catch {
    return [];
  }
}

/** Unwrap a web-ifc IfcValue to a primitive (handles .value / .wrappedValue / _representationValue). */
function unwrapValue(nominal: unknown): unknown {
  if (nominal == null || typeof nominal !== "object") return nominal;
  const o = nominal as Record<string, unknown>;
  if ("value" in o && o.value != null) return o.value;
  if ("wrappedValue" in o && o.wrappedValue != null) return o.wrappedValue;
  if ("_representationValue" in o && o._representationValue != null) return o._representationValue;
  return nominal;
}

/** Read {propName → value} from an IfcPropertySet line's HasProperties. */
function readPropertySet(api: IfcAPI, modelID: number, pset: any): { name: string; props: Record<string, unknown> } | null {
  if (!pset || !Array.isArray(pset.HasProperties)) return null; // not an IfcPropertySet
  const name = str(pset.Name);
  if (!name) return null;
  const props: Record<string, unknown> = {};
  for (const propRef of pset.HasProperties) {
    const prop = line(api, modelID, propRef);
    if (!prop || prop.NominalValue == null) continue;
    props[str(prop.Name)] = unwrapValue(prop.NominalValue);
  }
  return Object.keys(props).length > 0 ? { name, props } : null;
}

/**
 * Build a per-element property-set map. Merges TYPE psets (via IfcRelDefinesByType
 * → IfcTypeObject.HasPropertySets — where Revit puts per-profile "Structural Analysis"
 * stiffness) as a base, then INSTANCE psets (via IfcRelDefinesByProperties — e.g. the
 * per-member "Constraints" rotation) which override. Only IfcPropertySet /
 * IfcPropertySingleValue are read.
 */
function buildPsetMap(api: IfcAPI, modelID: number): PsetMap {
  const map: PsetMap = new Map();

  const attach = (objRefs: unknown[], name: string, props: Record<string, unknown>) => {
    for (const objRef of objRefs) {
      const objId = handleId(objRef);
      if (objId == null) continue;
      const existing = map.get(objId);
      if (existing) existing[name] = { ...(existing[name] ?? {}), ...props };
      else map.set(objId, { [name]: props });
    }
  };

  // 1) Type-level psets (base).
  for (const relId of ids(api, modelID, IFCRELDEFINESBYTYPE)) {
    const rel = line(api, modelID, relId);
    if (!rel || !Array.isArray(rel.RelatedObjects)) continue;
    const type = line(api, modelID, rel.RelatingType);
    if (!type || !Array.isArray(type.HasPropertySets)) continue;
    for (const psRef of type.HasPropertySets) {
      const parsed = readPropertySet(api, modelID, line(api, modelID, psRef));
      if (parsed) attach(rel.RelatedObjects, parsed.name, parsed.props);
    }
  }

  // 2) Instance-level psets (override).
  for (const relId of ids(api, modelID, IFCRELDEFINESBYPROPERTIES)) {
    const rel = line(api, modelID, relId);
    if (!rel || !Array.isArray(rel.RelatedObjects)) continue;
    const parsed = readPropertySet(api, modelID, line(api, modelID, rel.RelatingPropertyDefinition));
    if (parsed) attach(rel.RelatedObjects, parsed.name, parsed.props);
  }

  return map;
}

/** Structural properties read from psets, in engineering units. */
interface PsetInfo {
  rotationDeg: number | null;
  sectionAreaMm2: number | null;
  iStrongCm4: number | null;
  iWeakCm4: number | null;
}

function psetNum(psets: Record<string, Record<string, unknown>> | undefined, pset: string, prop: string): number | null {
  const v = psets?.[pset]?.[prop];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Extract the relevant structural pset values for one element, with unit conversion. */
function readPsetInfo(psets: Record<string, Record<string, unknown>> | undefined): PsetInfo {
  const rot = psetNum(psets, "Constraints", "Cross-Section Rotation");
  const areaM2 = psetNum(psets, "Structural Analysis", "Section Area");
  const iStrongM4 = psetNum(psets, "Structural Analysis", "Moment of Inertia strong axis");
  const iWeakM4 = psetNum(psets, "Structural Analysis", "Moment of Inertia weak axis");
  return {
    // Revit writes this raw and unnormalized (e.g. -350.68 instead of 9.32) —
    // round to match rotationIdeaDeg's precision; this is now the PRIMARY
    // Alfa source (see extractMemberVectors), so display-grade rounding
    // matters here, unlike when it was only a tooltip cross-check.
    rotationDeg: rot != null ? Math.round(rot * 100) / 100 : null,
    sectionAreaMm2: areaM2 != null ? Math.round(areaM2 * 1e6) : null, // m² → mm²
    iStrongCm4: iStrongM4 != null ? Math.round(iStrongM4 * 1e8) : null, // m⁴ → cm⁴
    iWeakCm4: iWeakM4 != null ? Math.round(iWeakM4 * 1e8) : null,
  };
}

// ---------------------------------------------------------------------------
// Profile + material (via IfcRelAssociatesMaterial)
// ---------------------------------------------------------------------------

interface MatProfile {
  profile: string;
  material: string;
}

/** Build elementExpressId → { profile, material } from IfcRelAssociatesMaterial. */
function buildMaterialMap(api: IfcAPI, modelID: number): Map<number, MatProfile> {
  const map = new Map<number, MatProfile>();
  let relIds: { size(): number; get(i: number): number } | number[];
  try {
    relIds = api.GetLineIDsWithType(modelID, IFCRELASSOCIATESMATERIAL) as any;
  } catch {
    return map;
  }
  const count = Array.isArray(relIds) ? relIds.length : relIds.size();
  for (let i = 0; i < count; i++) {
    const relId = Array.isArray(relIds) ? relIds[i] : relIds.get(i);
    const rel = line(api, modelID, relId);
    if (!rel || !Array.isArray(rel.RelatedObjects)) continue;

    const { profile, material } = resolveMaterialSelect(api, modelID, rel.RelatingMaterial);
    for (const objRef of rel.RelatedObjects) {
      const objId = handleId(objRef);
      if (objId != null && !map.has(objId)) map.set(objId, { profile, material });
    }
  }
  return map;
}

/** Resolve an IfcMaterialSelect (Material / ProfileSet / LayerSet / List) → names. */
function resolveMaterialSelect(api: IfcAPI, modelID: number, ref: unknown): MatProfile {
  const mat = line(api, modelID, ref);
  if (!mat) return { profile: "", material: "" };
  const type = str(mat.type ?? "");

  // IfcMaterial
  if ("Name" in mat && !("MaterialProfiles" in mat) && !("MaterialLayers" in mat) && !("Materials" in mat) && !("ForProfileSet" in mat) && !("Material" in mat)) {
    return { profile: "", material: str(mat.Name) };
  }

  // IfcMaterialProfileSetUsage → ForProfileSet
  if (mat.ForProfileSet) {
    return resolveMaterialSelect(api, modelID, mat.ForProfileSet);
  }

  // IfcMaterialProfileSet → MaterialProfiles[]
  if (Array.isArray(mat.MaterialProfiles) && mat.MaterialProfiles.length > 0) {
    const mp = line(api, modelID, mat.MaterialProfiles[0]);
    if (mp) {
      const prof = line(api, modelID, mp.Profile);
      const innerMat = line(api, modelID, mp.Material);
      return {
        profile: prof ? str(prof.ProfileName) : "",
        material: innerMat ? str(innerMat.Name) : str(mat.Name),
      };
    }
  }

  // IfcMaterialProfile (single)
  if ("Profile" in mat && "Material" in mat) {
    const prof = line(api, modelID, mat.Profile);
    const innerMat = line(api, modelID, mat.Material);
    return { profile: prof ? str(prof.ProfileName) : "", material: innerMat ? str(innerMat.Name) : "" };
  }

  // IfcMaterialLayerSet(Usage) → LayerSetName / first layer material
  if (Array.isArray(mat.MaterialLayers) && mat.MaterialLayers.length > 0) {
    const layer = line(api, modelID, mat.MaterialLayers[0]);
    const innerMat = layer ? line(api, modelID, layer.Material) : null;
    return { profile: "", material: innerMat ? str(innerMat.Name) : str(mat.LayerSetName) };
  }
  if (mat.ForLayerSet) return resolveMaterialSelect(api, modelID, mat.ForLayerSet);

  // IfcMaterialList → Materials[]
  if (Array.isArray(mat.Materials) && mat.Materials.length > 0) {
    const first = line(api, modelID, mat.Materials[0]);
    return { profile: "", material: first ? str(first.Name) : "" };
  }

  // Fallback
  return { profile: "", material: str(mat.Name ?? type) };
}

/** Cross-section area (mm²) for the common parametric profile defs, else null. */
function profileArea(profile: any): number | null {
  if (!profile) return null;
  if (profile.type === IFCISHAPEPROFILEDEF) {
    const b = num(profile.OverallWidth);
    const h = num(profile.OverallDepth);
    const tw = num(profile.WebThickness);
    const tf = num(profile.FlangeThickness);
    if (b > 0 && h > 0 && tw > 0 && tf > 0) return 2 * b * tf + (h - 2 * tf) * tw;
    return null;
  }
  if (profile.type === IFCRECTANGLEPROFILEDEF) {
    const a = num(profile.XDim);
    const b = num(profile.YDim);
    return a > 0 && b > 0 ? a * b : null;
  }
  if (profile.type === IFCCIRCLEPROFILEDEF) {
    const r = num(profile.Radius);
    return r > 0 ? Math.PI * r * r : null;
  }
  return null;
}

/**
 * Fallback profile name from the element's own `Description`/`ObjectType`
 * attributes. Some Tekla-authored IFCs carry no `IfcProfileDef` at all and
 * instead stash the section string ("HEA240", "CHS139.7*6.3", ...) directly on
 * the element as metadata. Tried only after the geometry/material-based lookups.
 */
function profileFromElementMetadata(api: IfcAPI, modelID: number, element: any): string {
  const description = str(element.Description);
  if (description) return description;
  return str(element.ObjectType);
}

/** Trailing mass-per-metre (kg/m) from a UB/UC-style profile name, as an area proxy. */
function massFromName(name: string): number | null {
  const m = name.match(/[xX](\d+(?:\.\d+)?)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Resolve the swept-area profile from the Body representation → { name, area }.
 * Traverses IfcMappedItem (type-shared geometry, used by all columns here) so
 * column profiles resolve too. Area is exact for parametric profiles; when the
 * profile def has no computable area, falls back to the profile-name mass proxy.
 */
function sweptAreaProfileInfo(api: IfcAPI, modelID: number, element: any): { name: string; area: number | null } {
  const prodShape = line(api, modelID, element.Representation);
  if (!prodShape || !Array.isArray(prodShape.Representations)) return { name: "", area: null };

  const findSwept = (itemRef: unknown): any | null => {
    const item = line(api, modelID, itemRef);
    if (!item) return null;
    if (item.type === IFCMAPPEDITEM) {
      const ms = line(api, modelID, item.MappingSource);
      const mappedRep = ms ? line(api, modelID, ms.MappedRepresentation) : null;
      if (mappedRep && Array.isArray(mappedRep.Items)) {
        for (const inner of mappedRep.Items) {
          const found = findSwept(inner);
          if (found) return found;
        }
      }
      return null;
    }
    // Members at a joint are usually coped/mitered — their body is an
    // IfcBooleanClippingResult (extrusion clipped by a half-space), not a bare
    // swept solid. The profile lives in the base operand, so descend into the
    // boolean's operands (FirstOperand is the base solid; check SecondOperand
    // too for safety) to reach the underlying IfcExtrudedAreaSolid.
    if (item.type === IFCBOOLEANCLIPPINGRESULT || item.type === IFCBOOLEANRESULT) {
      return findSwept(item.FirstOperand) ?? findSwept(item.SecondOperand);
    }
    return item.SweptArea ? line(api, modelID, item.SweptArea) : null;
  };

  for (const repRef of prodShape.Representations) {
    const rep = line(api, modelID, repRef);
    if (!rep || !Array.isArray(rep.Items)) continue;
    for (const itemRef of rep.Items) {
      const swept = findSwept(itemRef);
      if (swept && swept.ProfileName != null) {
        const name = str(swept.ProfileName);
        return { name, area: profileArea(swept) ?? massFromName(name) };
      }
    }
  }
  return { name: "", area: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Map a web-ifc entity-type constant to its IFC class name string. */
function ifcClassName(entityType: number): "IfcBeam" | "IfcColumn" | "IfcMember" {
  if (entityType === IFCBEAM) return "IfcBeam";
  if (entityType === IFCCOLUMN) return "IfcColumn";
  return "IfcMember";
}

/** Round helper matching the script's precision. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Given the object's OWN placement axes (local-X/Y/Z) and the independently-
 * derived length-direction unit vector, identify which of the three is the true
 * length axis (by max |dot|) and return the other two as the cross-section
 * frame, plus the confidence (|dot|) and the winning axis's index. Different IFC
 * elements can use different local axes as "length" (this file has both local-X
 * beams and a local-Z column) — detected per-element, never assumed from IfcClass.
 */
function pickCrossSectionAxes(
  localAxes: [[number, number, number], [number, number, number], [number, number, number]],
  unit: [number, number, number],
): {
  axisA: [number, number, number];
  axisB: [number, number, number];
  lengthAxisIdx: number;
  confidence: number;
} {
  const dots = localAxes.map((c) => Math.abs(c[0] * unit[0] + c[1] * unit[1] + c[2] * unit[2]));
  let lengthAxisIdx = 0;
  for (let i = 1; i < 3; i++) if (dots[i] > dots[lengthAxisIdx]) lengthAxisIdx = i;
  const remaining = [0, 1, 2].filter((i) => i !== lengthAxisIdx);
  return {
    axisA: localAxes[remaining[0]],
    axisB: localAxes[remaining[1]],
    lengthAxisIdx,
    confidence: dots[lengthAxisIdx],
  };
}

/**
 * Extract member vectors for the given GlobalIds, preserving `orderedGlobalIds`
 * order in the output. Requires an already-open web-ifc model.
 */
export function extractMemberVectors(
  api: IfcAPI,
  modelID: number,
  orderedGlobalIds: string[],
  options?: { allowBrepFallback?: boolean },
): MemberVectorRow[] {
  const allowBrepFallback = options?.allowBrepFallback ?? false;
  const target = new Set(orderedGlobalIds);
  const materialMap = buildMaterialMap(api, modelID);
  const psetMap = buildPsetMap(api, modelID);
  const byGlobalId = new Map<string, MemberVectorRow>();

  for (const entityType of [IFCBEAM, IFCCOLUMN, IFCMEMBER]) {
    const idList = api.GetLineIDsWithType(modelID, entityType) as any;
    const count = Array.isArray(idList) ? idList.length : idList.size();
    for (let i = 0; i < count; i++) {
      const id = Array.isArray(idList) ? idList[i] : idList.get(i);
      const element = line(api, modelID, id);
      if (!element) continue;

      const globalId = str(element.GlobalId);
      if (!target.has(globalId)) continue;

      // Centerline resolver: picks the best of several extraction strategies,
      // centroid-corrects a curved member, and cross-checks the methods. Returns
      // WORLD start/end/curve/tangents + the object's own placement matrix (used
      // below for the local-X/Y/Z rotation frame — deliberately NOT composed
      // with any Axis mapped-item transform, matching ifcopenshell's
      // get_local_placement, so Alfa isn't silently rotated).
      const resolved = resolveCenterline(api, modelID, element, { allowMesh: allowBrepFallback });
      if (!resolved) continue;
      const { start, end, curve, tangentStart, tangentEnd, placementMatrix } = resolved;

      const vec: [number, number, number] = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
      const length = Math.hypot(vec[0], vec[1], vec[2]);
      const unit: [number, number, number] =
        length === 0 ? [0, 0, 0] : [vec[0] / length, vec[1] / length, vec[2] / length];

      // Placement local axes (global unit vectors) = placementMatrix columns 0/1/2.
      const localX = normalize([placementMatrix[0], placementMatrix[4], placementMatrix[8]]) as [number, number, number];
      const localY = normalize([placementMatrix[1], placementMatrix[5], placementMatrix[9]]) as [number, number, number];
      const localZ = normalize([placementMatrix[2], placementMatrix[6], placementMatrix[10]]) as [number, number, number];
      const localAxes: [[number, number, number], [number, number, number], [number, number, number]] = [localX, localY, localZ];

      const { axisA, axisB, lengthAxisIdx, confidence } = pickCrossSectionAxes(localAxes, unit);

      // Geometric IDEA-convention rotation about the member's TRUE length axis.
      // Most members have local-X along length, but at least one column here has
      // local-Z along length; `lengthAxisIdx` detects it per-element and the
      // rotation reference is the NEXT axis in the right-handed cyclic order.
      const lengthAxis = localAxes[lengthAxisIdx];
      const rotationRefAxis = localAxes[(lengthAxisIdx + 1) % 3];
      const rotationIdeaDeg =
        Math.round(signedAngleDeg(lengthAxis, referencePerp(lengthAxis), rotationRefAxis) * 100) / 100;
      // Axis-direction vs placement length-axis alignment check (QA): 0° = the
      // detected length axis runs along the axis curve; a large value flags a
      // member where no placement axis lines up (rotation/section axes unreliable).
      const alignmentDeg =
        length === 0 ? 0 : Math.round((Math.acos(Math.min(1, confidence)) * 180) / Math.PI * 100) / 100;

      const mp = materialMap.get(id) ?? { profile: "", material: "" };
      const sweptInfo = sweptAreaProfileInfo(api, modelID, element);
      const metadataProfile = mp.profile || sweptInfo.name ? "" : profileFromElementMetadata(api, modelID, element);
      const profile = mp.profile || sweptInfo.name || metadataProfile;
      const crossSectionArea = sweptInfo.area ?? (metadataProfile ? massFromName(metadataProfile) : null);
      const pset = readPsetInfo(psetMap.get(id));

      byGlobalId.set(globalId, {
        globalId,
        tag: str(element.Tag),
        name: str(element.Name),
        ifcClass: ifcClassName(entityType),
        start: [r3(start[0]), r3(start[1]), r3(start[2])],
        end: [r3(end[0]), r3(end[1]), r3(end[2])],
        vector: [r3(vec[0]), r3(vec[1]), r3(vec[2])],
        crossSectionAxisA: [r4(axisA[0]), r4(axisA[1]), r4(axisA[2])],
        crossSectionAxisB: [r4(axisB[0]), r4(axisB[1]), r4(axisB[2])],
        axisConfidence: Math.round(confidence * 1000) / 1000,
        localX: [r4(localX[0]), r4(localX[1]), r4(localX[2])],
        localY: [r4(localY[0]), r4(localY[1]), r4(localY[2])],
        localZ: [r4(localZ[0]), r4(localZ[1]), r4(localZ[2])],
        rotationIdeaDeg,
        alignmentDeg,
        unit: [r4(unit[0]), r4(unit[1]), r4(unit[2])],
        length: Math.round(length * 100) / 100,
        profile,
        crossSectionArea: crossSectionArea != null ? Math.round(crossSectionArea) : null,
        material: mp.material,
        rotationDeg: pset.rotationDeg,
        sectionAreaMm2: pset.sectionAreaMm2,
        iStrongCm4: pset.iStrongCm4,
        iWeakCm4: pset.iWeakCm4,
        tangentStart: tangentStart ? [r4(tangentStart[0]), r4(tangentStart[1]), r4(tangentStart[2])] : undefined,
        tangentEnd: tangentEnd ? [r4(tangentEnd[0]), r4(tangentEnd[1]), r4(tangentEnd[2])] : undefined,
        curve,
        centerlineSource: resolved.source,
        centerlineAgreementMm: resolved.agreementMm,
      });
    }
  }

  // Preserve requested order; drop unresolved ids.
  return orderedGlobalIds
    .map((gid) => byGlobalId.get(gid))
    .filter((r): r is MemberVectorRow => r != null);
}

export interface MemberEndpoints {
  globalId: string;
  ifcClass: "IfcBeam" | "IfcColumn" | "IfcMember";
  start: [number, number, number];
  end: [number, number, number];
}

/**
 * Lightweight bulk pass over every beam/column's global centerline start/end —
 * skips profile/material/cross-section work for speed. Used to find which
 * members share an endpoint (a structural joint). Uses the same centerline
 * resolver (so a curved member's ends are centroid-corrected here too, keeping
 * it within the 50 mm joint-membership tolerance in `findConnectedMembers`).
 */
export function extractAllMemberEndpoints(
  api: IfcAPI,
  modelID: number,
  options?: { allowBrepFallback?: boolean },
): MemberEndpoints[] {
  const allowBrepFallback = options?.allowBrepFallback ?? false;
  const out: MemberEndpoints[] = [];
  for (const entityType of [IFCBEAM, IFCCOLUMN, IFCMEMBER]) {
    const idList = api.GetLineIDsWithType(modelID, entityType) as any;
    const count = Array.isArray(idList) ? idList.length : idList.size();
    for (let i = 0; i < count; i++) {
      const id = Array.isArray(idList) ? idList[i] : idList.get(i);
      const element = line(api, modelID, id);
      if (!element) continue;

      const resolved = resolveCenterline(api, modelID, element, { allowMesh: allowBrepFallback });
      if (!resolved) continue;

      out.push({
        globalId: str(element.GlobalId),
        ifcClass: ifcClassName(entityType),
        start: [r3(resolved.start[0]), r3(resolved.start[1]), r3(resolved.start[2])],
        end: [r3(resolved.end[0]), r3(resolved.end[1]), r3(resolved.end[2])],
      });
    }
  }
  return out;
}

export interface MemberTagEntry {
  globalId: string;
  tag: string;
  ifcClass: "IfcBeam" | "IfcColumn" | "IfcMember";
  name: string;
}

/**
 * Lightweight bulk pass over every beam/column's Tag/GlobalId/Name — no geometry
 * or property work. Used to jump straight to a member by its Tag without
 * shift-clicking through the viewer.
 */
export function extractAllMemberTags(api: IfcAPI, modelID: number): MemberTagEntry[] {
  const out: MemberTagEntry[] = [];
  for (const entityType of [IFCBEAM, IFCCOLUMN, IFCMEMBER]) {
    for (const id of ids(api, modelID, entityType)) {
      const element = line(api, modelID, id);
      if (!element) continue;
      out.push({
        globalId: str(element.GlobalId),
        tag: str(element.Tag),
        ifcClass: ifcClassName(entityType),
        name: str(element.Name),
      });
    }
  }
  return out;
}

/** Browser convenience: open IFC bytes, list every beam/column Tag/GlobalId, close. */
export async function extractAllMemberTagsFromBytes(bytes: Uint8Array): Promise<MemberTagEntry[]> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    return extractAllMemberTags(api, modelID);
  } finally {
    api.CloseModel(modelID);
  }
}

/**
 * Fast GlobalId → profile-name lookup for a specific set of members — used by
 * the selection screen to show a profile hint next to each picked member
 * without paying for the full extraction (skips body-geometry parsing, so a
 * member whose profile only resolves via swept-solid geometry comes back
 * empty here; the full Extract step still finds it).
 */
export function extractMemberProfilesByGlobalIds(
  api: IfcAPI,
  modelID: number,
  globalIds: Set<string>,
): Map<string, string> {
  const materialMap = buildMaterialMap(api, modelID);
  const out = new Map<string, string>();
  for (const entityType of [IFCBEAM, IFCCOLUMN, IFCMEMBER]) {
    for (const id of ids(api, modelID, entityType)) {
      const element = line(api, modelID, id);
      if (!element) continue;
      const globalId = str(element.GlobalId);
      if (!globalIds.has(globalId)) continue;
      const profile = materialMap.get(id)?.profile || profileFromElementMetadata(api, modelID, element);
      if (profile) out.set(globalId, profile);
    }
  }
  return out;
}

/** Browser convenience: open IFC bytes, resolve profiles for the given GlobalIds, close. */
export async function extractMemberProfilesByGlobalIdsFromBytes(
  bytes: Uint8Array,
  globalIds: string[],
): Promise<Map<string, string>> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    return extractMemberProfilesByGlobalIds(api, modelID, new Set(globalIds));
  } finally {
    api.CloseModel(modelID);
  }
}

/**
 * Browser convenience: open the IFC bytes with a fresh web-ifc model, extract,
 * and close. Reuses the already-bundled web-ifc WASM at /wasm/web-ifc/.
 */
export async function extractMemberVectorsFromBytes(
  bytes: Uint8Array,
  orderedGlobalIds: string[],
  options?: { allowBrepFallback?: boolean },
): Promise<MemberVectorRow[]> {
  const api = new IfcAPI();
  api.SetWasmPath(WASM_PATH, true);
  await api.Init();
  const modelID = api.OpenModel(bytes);
  try {
    return extractMemberVectors(api, modelID, orderedGlobalIds, options);
  } finally {
    api.CloseModel(modelID);
  }
}
