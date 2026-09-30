/**
 * Connection Design Assistant — shared type definitions.
 *
 * These types drive the template grid, load input, API request/response,
 * and analysis result display.
 */

/** Geometry classification auto-detected from selected members. */
export type ConnectionGeometry =
  | 'beam-to-column'      // 1 column + 1+ beams at ~90°
  | 'beam-to-beam'        // 2 beams inline (splice)
  | 'brace-to-column'     // column + diagonal brace
  | 'brace-to-beam'       // beam + diagonal brace
  | 'multi-member'        // 3+ members meeting at a node
  | 'base-plate';         // single column (future)

/** Connection behavior classification. */
export type ConnectionBehavior = 'shear' | 'moment' | 'axial';

/** A connection design template shown in the Smart Template Grid. */
export interface ConnectionTemplate {
  id: string;
  name: string;
  nameLocal: string;          // Turkish display name
  description: string;
  descriptionLocal: string;   // Turkish hover tooltip
  geometry: ConnectionGeometry;
  behavior: ConnectionBehavior;
  /** SVG icon name or emoji placeholder */
  icon: string;
  /** Whether this is a recommended template for the detected geometry */
  isRecommended?: boolean;
  /** Recommendation reason shown on hover */
  recommendationReason?: string;
  recommendationReasonLocal?: string;
  /** Default connection parameters */
  defaults: ConnectionDefaults;
}

/** Default parameter values for a connection template. */
export interface ConnectionDefaults {
  plateThicknessMm: number;
  boltDiameter: BoltDiameter;
  boltGrade: string;
  boltCount: number;
  boltRows: number;
  boltCols: number;
  weldThicknessMm: number;
  weldType: 'fillet' | 'butt';
  /** For end plates: plate width/height relative to beam */
  plateWidthMm?: number;
  plateHeightMm?: number;
  /** For fin plates */
  finPlateDepthMm?: number;
}

/** Standard bolt diameters */
export type BoltDiameter = 'M12' | 'M16' | 'M20' | 'M24' | 'M27' | 'M30';

/** Design load effects for the connection. */
export interface DesignLoads {
  /** Axial force in kN (positive = tension) */
  N: number;
  /** Shear force in kN */
  V: number;
  /** Bending moment in kNm */
  M: number;
}

/** Member capacity estimates for smart default loads. */
export interface MemberCapacity {
  /** Plastic moment capacity Mpl (kNm) */
  Mpl: number;
  /** Plastic shear capacity Vpl (kN) */
  Vpl: number;
  /** Axial capacity Npl (kN) */
  Npl: number;
  /** Profile name used for calculation */
  profile: string;
  /** Steel grade used */
  steelGrade: string;
}

/** Parameters sent to the IDEA StatiCa API for analysis. */
export interface AnalysisRequest {
  /** IOM XML string (geometry) */
  iomXml: string;
  /** Selected template */
  templateId: string;
  /** Design loads */
  loads: DesignLoads;
  /** Connection parameters (overrides template defaults) */
  params: ConnectionDefaults;
}

/** Individual check result from IDEA StatiCa. */
export interface CheckResult {
  /** Component name (e.g., "Bolts in shear", "End plate in bending") */
  name: string;
  /** Unity check value (0-1 = pass, >1 = fail) */
  unityCheck: number;
  /** Pass/fail status */
  status: 'pass' | 'fail' | 'warning';
  /** Detailed message from IDEA StatiCa */
  message: string;
}

/** Analysis result from IDEA StatiCa. */
export interface AnalysisResult {
  /** Overall status */
  overallStatus: 'pass' | 'fail';
  /** Maximum unity check across all components */
  maxUnityCheck: number;
  /** Individual check results */
  checks: CheckResult[];
  /** Raw JSON response for debugging */
  rawResponse?: unknown;
  /** Timestamp of analysis */
  timestamp: number;
}

/** Auto-fix recommendation when analysis fails. */
export interface AutoFixRecommendation {
  /** Human-readable description */
  description: string;
  descriptionLocal: string;
  /** Which parameter to change */
  parameterKey: keyof ConnectionDefaults;
  /** Current value */
  currentValue: string | number;
  /** Recommended new value */
  recommendedValue: string | number;
  /** Expected improvement reason */
  reason: string;
  reasonLocal: string;
  /** Priority (1 = try first) */
  priority: number;
}

/** The overall state of the connection design workflow. */
export type DesignStep = 'template-select' | 'load-input' | 'analyzing' | 'results';

/** Full state for the connection design panel. */
export interface ConnectionDesignState {
  step: DesignStep;
  selectedTemplate: ConnectionTemplate | null;
  loads: DesignLoads;
  params: ConnectionDefaults | null;
  result: AnalysisResult | null;
  recommendations: AutoFixRecommendation[];
  isAnalyzing: boolean;
  error: string | null;
  /** Auto-detected geometry from member selection */
  detectedGeometry: ConnectionGeometry | null;
  /** Estimated member capacity for smart defaults */
  memberCapacity: MemberCapacity | null;
}
