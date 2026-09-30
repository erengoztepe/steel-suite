/** A member (beam/column) resolved to its Axis centerline vector + metadata. */
export interface MemberVectorRow {
  globalId: string;
  tag: string;
  name: string;
  ifcClass: string;
  /** Global start coordinate [x, y, z] (mm), Axis polyline first point. */
  start: [number, number, number];
  /** Global end coordinate [x, y, z] (mm), Axis polyline last point. */
  end: [number, number, number];
  /** Direction vector end - start (mm). */
  vector: [number, number, number];
  /** Unit direction vector. */
  unit: [number, number, number];
  /**
   * Local tangent fit only from the mesh near the `start`/`end` cap, instead
   * of the whole member — set only for bent/curved members (via the Tekla
   * Brep-PCA fallback) where this differs meaningfully from the whole-length
   * chord. The joint solver prefers whichever one ends up as the "close" end
   * over the chord, since a bent member's connection angle is the tangent
   * where it frames into the joint, not its average slope. Undefined for
   * every straight member.
   */
  tangentStart?: [number, number, number];
  tangentEnd?: [number, number, number];
  /**
   * Exact analytic centerline (world space), set only when the Axis
   * representation is an IfcTrimmedCurve on an IfcCircle — a real circular-arc
   * member. Lets the joint solver find the point ON THE CURVE nearest the
   * joint (instead of assuming the joint is at one of this member's own two
   * ends, which is wrong for a member running continuously THROUGH the
   * joint) and use the curve's own tangent there.
   */
  curve?: {
    center: [number, number, number];
    xAxis: [number, number, number];
    yAxis: [number, number, number];
    radius: number;
    theta1: number;
    theta2: number;
  };
  /** Member length (mm). */
  length: number;
  /** Cross-section / profile name, when resolvable. */
  profile: string;
  /**
   * Cross-section area in mm² (exact for parametric profiles; falls back to the
   * profile-name mass-per-metre proxy). Used as a stiffness (EI/AE) proxy for
   * bearing-member suggestion. null when nothing resolvable.
   */
  crossSectionArea: number | null;
  /** Material name, when resolvable. */
  material: string;
  /**
   * The two cross-section (profile-plane) axes, as global unit vectors — the
   * object's own local frame axes that are NOT the length axis. Together with
   * `unit`, these fully describe how the cross-section is rotated about the
   * member's length. Raw geometric truth; not mapped to any specific tool's
   * "rotation angle" convention (that mapping needs calibrating against a
   * known reference member).
   */
  crossSectionAxisA: [number, number, number];
  crossSectionAxisB: [number, number, number];
  /**
   * |dot product| of the local axis picked as "length axis" against `unit`.
   * Should be ~1.0; a lower value means the length-axis heuristic was
   * uncertain for this element and crossSectionAxisA/B may not be reliable.
   */
  axisConfidence: number;
  /**
   * Profile rotation about the member axis (degrees), read directly from the IFC
   * `Constraints."Cross-Section Rotation"` pset. The human-readable "beta angle"
   * engineers/IDEA think in; complements the geometric axes above. null if absent.
   */
  rotationDeg: number | null;
  /** Section area (mm²) from the IFC `Structural Analysis` pset — true value, not derived. null if absent. */
  sectionAreaMm2: number | null;
  /** Second moment of area about the strong axis (cm⁴), from the IFC pset — EI proxy for bearing. null if absent. */
  iStrongCm4: number | null;
  /** Second moment of area about the weak axis (cm⁴), from the IFC pset. null if absent. */
  iWeakCm4: number | null;
  /** Placement local axes as global unit vectors (matrix columns 0/1/2). Used for the local-frame offset. */
  localX: [number, number, number];
  localY: [number, number, number];
  localZ: [number, number, number];
  /**
   * Geometric rotation of the section about the member axis (degrees), in IDEA's
   * "rotation = 0" convention (computed from the local frame, not the raw IFC
   * pset). This is the value to enter into IDEA. null if not computable.
   */
  rotationIdeaDeg: number | null;
  /**
   * Angle (degrees) between the Axis-polyline direction and the placement
   * local-X. Should be ~0; a larger value flags an IFC where the axis
   * representation and placement disagree (treat rotation/offset with caution).
   */
  alignmentDeg: number;
  /**
   * Which extraction strategy produced this centerline (`axis-polyline`,
   * `axis-line`, `axis-circle`, `body-extrusion`, `mesh-pca`). QA visibility +
   * the basis for future toggle-free automatic method selection.
   */
  centerlineSource: string;
  /**
   * Max endpoint disagreement (mm) between the chosen extraction method and the
   * best comparable alternative that also resolved — undefined when only one
   * method applied. A large value flags a member whose methods disagree.
   */
  centerlineAgreementMm?: number;
}

/** A row after the joint solve (close→far orientation + eccentricity offset). */
export interface OrientedMemberVectorRow extends MemberVectorRow {
  /** true when this member's vector was manually flipped from the deterministic close→far direction. */
  flipped: boolean;
  /**
   * Geometrical type (IDEA's per-member Continuous/Ended classification): true
   * when this member runs continuously through the joint. Independent of
   * `isBearing` — a bearing member can itself be Ended (a truss chord that
   * terminates at the panel point), and a non-bearing attached member can be
   * Continuous (passes through, framing on both sides).
   */
  isContinuous: boolean;
  /** true when this is the single member the connection node is anchored to (IDEA's bearing/reference member). */
  isBearing: boolean;
  /**
   * Raw endpoint delta (mm): closeEnd − connectionNode. Positions the member;
   * mixes along-axis + perpendicular components.
   */
  offset: [number, number, number];
  /**
   * Structural eccentricity (mm): perpendicular distance from the node to this
   * member's axis. The moment arm (secondary moment = N·e); the meaningful
   * "how far the axis misses the joint" number, unlike |offset|.
   */
  eccentricityMm: number;
  /**
   * Offset expressed in the member's OWN local frame (mm): [0, ey, ez] =
   * [0, Rᵧᵀ·(closeEnd − node), R_zᵀ·(closeEnd − node)], R = [localX|localY|localZ].
   * The along-axis component (ex) is NOT computed: IDEA trims/slides a member
   * freely along its own axis, so ex carries no structural meaning. Only ey/ez
   * (cross-section-plane offset = eccentricity) matter. This is IDEA StatiCa's
   * "Offset ey/ez" input directly. The bearing member is defined as [0,0,0].
   */
  offsetLocal: [number, number, number];
}
