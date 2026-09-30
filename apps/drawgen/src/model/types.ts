// Stack-agnostic internal connection model, extracted from IDEA IOM (+ IFC later).
// All lengths are in MILLIMETRES (IOM is metres; converted on ingest).

export interface Vec3 { x: number; y: number; z: number; }
export interface Pt2 { x: number; y: number; }

/** Local coordinate system: origin + orthonormal axes (global mm / unit vectors). */
export interface LCS {
  origin: Vec3;
  ax: Vec3; // local X (in plane)
  ay: Vec3; // local Y (in plane)
  az: Vec3; // local Z (normal / thickness direction)
}

export interface CrossSection {
  id: number;
  name: string;          // e.g. "HE550A", "IPE300"
  type: string;          // e.g. "RolledI"
  params: Record<string, number>; // B,H,s(web),t(flange),r1,r2 ... (mm)
}

export interface Cut {
  planePoint: Vec3;
  normal: Vec3;
  direction: string;     // e.g. "Parallel"
  offset: number;        // mm
}

export interface Member {
  id: number;
  name: string;                 // beam name, e.g. "HEA550A"
  isBearing: boolean;
  section?: CrossSection;       // resolved cross-section
  axis?: { start: Vec3; end: Vec3 };      // global mm
  // Section orientation in global space: profile width along `vy`, height along `vz`.
  sectionFrame?: { vy: Vec3; vz: Vec3 };
  cuts: Cut[];
}

export interface Plate {
  id: number;
  name: string;                 // e.g. "SHP1"
  originalId: string;           // e.g. "Plate7"
  thickness: number;            // mm
  material: string;
  lcs: LCS;                     // placement plane
  outline: Pt2[];               // closed polygon in local 2D (mm)
  isNegative: boolean;
}

export interface BoltAssembly {
  id: number;
  name: string;                 // e.g. "20 A490M"
  diameter: number;             // mm
  borehole: number;             // hole diameter, mm
  grade: string;                // parsed from name, e.g. "A490M"
  headDiameter: number;         // mm
  headHeight: number;           // mm
  nutThickness: number;         // mm
}

export interface BoltGrid {
  id: number;
  lcs: LCS;
  positions: Vec3[];            // global mm
  assembly?: BoltAssembly;
  connectedParts: { type: string; id: string }[];
  length: number;               // grip/bolt length, mm
}

export interface Weld {
  id: number;
  name: string;                 // descriptive, e.g. "SHP1 ([HEA550A, Web] - FinPlate)"
  type: string;                 // e.g. "DoubleFillet"
  thickness: number;            // throat/size, mm
  material: string;
  start: Vec3;                  // global mm
  end: Vec3;                    // global mm
  connectedPartIds: string[];
}

export interface ConnectionModel {
  projectName: string;
  countryCode: string;          // e.g. "American"
  source: string;               // file path / origin
  units: 'mm';
  members: Member[];
  plates: Plate[];
  boltGrids: BoltGrid[];
  welds: Weld[];
  crossSections: CrossSection[];
  boltAssemblies: BoltAssembly[];
}
