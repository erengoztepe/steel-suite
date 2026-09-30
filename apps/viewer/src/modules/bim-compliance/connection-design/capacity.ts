import { MemberCapacity, ConnectionBehavior, DesignLoads } from './types';

/**
 * Returns steel yield strength in MPa based on standard grades.
 */
export function getSteelYieldStrength(grade: string): number {
  const upper = grade.toUpperCase();
  if (upper.includes('235')) return 235;
  if (upper.includes('275')) return 275;
  if (upper.includes('355')) return 355;
  if (upper.includes('420')) return 420;
  if (upper.includes('460')) return 460;
  return 275; // Default fallback
}

/**
 * Approximate dimensions lookup for some common profile series to estimate capacity.
 * Real application would use a database.
 */
function estimateProfileProperties(profile: string) {
  // Dummy estimator
  const defaultA = 5000; // mm2
  const defaultWpl = 500000; // mm3
  const defaultAv = 2000; // mm2

  const match = profile.match(/(IPE|HEA|HEB|HEM|UB|UC)\s*(\d+)/i);
  if (match) {
    const type = match[1].toUpperCase();
    const size = parseInt(match[2], 10);
    // Extremely rough estimation logic
    return {
      A: size * 10,
      Wpl: size * size * 1.5,
      Av: size * 5
    };
  }

  return { A: defaultA, Wpl: defaultWpl, Av: defaultAv };
}

/**
 * Estimates member capacities.
 */
export function estimateMemberCapacity(
  profile: string,
  material: string,
  sectionAreaMm2: number | null,
  iStrongCm4: number | null
): MemberCapacity {
  const fy = getSteelYieldStrength(material); // MPa (N/mm2)
  const props = estimateProfileProperties(profile);
  
  const A = sectionAreaMm2 || props.A;
  
  // Wpl is roughly Wely * 1.15
  // And Wely = I / (h/2). We don't have h directly, we just fallback to rough estimation
  const Wpl = props.Wpl;
  const Av = props.Av;

  // Capacities
  // Npl = A * fy / 1000 (kN)
  const Npl = (A * fy) / 1000;
  
  // Vpl = (Av * (fy / sqrt(3))) / 1000 (kN)
  const Vpl = (Av * (fy / Math.sqrt(3))) / 1000;

  // Mpl = Wpl * fy / 1000000 (kNm)
  const Mpl = (Wpl * fy) / 1000000;

  return {
    Mpl: Math.round(Mpl),
    Vpl: Math.round(Vpl),
    Npl: Math.round(Npl),
    profile,
    steelGrade: material
  };
}

/**
 * Returns sensible default design loads based on member capacity.
 */
export function getDefaultLoads(
  capacity: MemberCapacity,
  behavior: ConnectionBehavior
): DesignLoads {
  if (behavior === 'shear') {
    return {
      N: 0,
      V: Math.round(capacity.Vpl * 0.5),
      M: 0
    };
  } else if (behavior === 'moment') {
    return {
      N: 0,
      V: Math.round(capacity.Vpl * 0.3),
      M: Math.round(capacity.Mpl * 0.5)
    };
  } else {
    // axial
    return {
      N: Math.round(capacity.Npl * 0.4),
      V: 0,
      M: 0
    };
  }
}
