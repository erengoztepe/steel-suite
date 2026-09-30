import { ConnectionTemplate, ConnectionGeometry } from './types';

export const TEMPLATES: ConnectionTemplate[] = [
  {
    id: 'fin-plate',
    name: 'Fin Plate',
    nameLocal: 'Bayrak Plakalı Birleşim',
    description: 'Simple shear connection using a single plate welded to column and bolted to beam web.',
    descriptionLocal: 'Kolona kaynaklı, kiriş gövdesine bulonlu basit kesme birleşimi.',
    geometry: 'beam-to-column',
    behavior: 'shear',
    icon: 'fin-plate-icon',
    defaults: {
      plateThicknessMm: 10,
      boltDiameter: 'M20',
      boltGrade: '8.8',
      boltCount: 3,
      boltRows: 3,
      boltCols: 1,
      weldThicknessMm: 6,
      weldType: 'fillet'
    }
  },
  {
    id: 'double-angle',
    name: 'Double Angle Cleat',
    nameLocal: 'Çift Korniyerli Birleşim',
    description: 'Traditional shear connection using two angles bolted or welded to members.',
    descriptionLocal: 'Elemanlara bulonlu veya kaynaklı iki korniyer kullanan geleneksel kesme birleşimi.',
    geometry: 'beam-to-column',
    behavior: 'shear',
    icon: 'double-angle-icon',
    defaults: {
      plateThicknessMm: 8,
      boltDiameter: 'M16',
      boltGrade: '8.8',
      boltCount: 6,
      boltRows: 3,
      boltCols: 2,
      weldThicknessMm: 5,
      weldType: 'fillet'
    }
  },
  {
    id: 'flexible-end-plate',
    name: 'Flexible End Plate',
    nameLocal: 'Esnek Alın Plakalı',
    description: 'Shear connection with a thin end plate welded to beam web.',
    descriptionLocal: 'Kiriş gövdesine kaynaklı ince alın plakalı kesme birleşimi.',
    geometry: 'beam-to-column',
    behavior: 'shear',
    icon: 'flexible-end-plate-icon',
    defaults: {
      plateThicknessMm: 10,
      boltDiameter: 'M20',
      boltGrade: '8.8',
      boltCount: 4,
      boltRows: 2,
      boltCols: 2,
      weldThicknessMm: 6,
      weldType: 'fillet'
    }
  },
  {
    id: 'extended-end-plate',
    name: 'Extended End Plate',
    nameLocal: 'Uzatılmış Alın Plakalı (Moment)',
    description: 'Rigid moment connection with plate extending beyond beam flanges.',
    descriptionLocal: 'Plakanın kiriş başlıklarının ötesine uzandığı rijit moment birleşimi.',
    geometry: 'beam-to-column',
    behavior: 'moment',
    icon: 'extended-end-plate-icon',
    defaults: {
      plateThicknessMm: 20,
      boltDiameter: 'M24',
      boltGrade: '10.9',
      boltCount: 8,
      boltRows: 4,
      boltCols: 2,
      weldThicknessMm: 8,
      weldType: 'fillet'
    }
  },
  {
    id: 'flush-end-plate',
    name: 'Flush End Plate',
    nameLocal: 'Hem Yüz Alın Plakalı',
    description: 'Semi-rigid connection with plate flush with beam flanges.',
    descriptionLocal: 'Plakanın kiriş başlıklarıyla aynı hizada olduğu yarı rijit birleşim.',
    geometry: 'beam-to-column',
    behavior: 'moment',
    icon: 'flush-end-plate-icon',
    defaults: {
      plateThicknessMm: 16,
      boltDiameter: 'M20',
      boltGrade: '8.8',
      boltCount: 6,
      boltRows: 3,
      boltCols: 2,
      weldThicknessMm: 6,
      weldType: 'fillet'
    }
  },
  {
    id: 'bolted-splice',
    name: 'Bolted Splice',
    nameLocal: 'Bulonlu Ek',
    description: 'Inline connection for continuous beams or columns.',
    descriptionLocal: 'Sürekli kirişler veya kolonlar için doğrusal ek.',
    geometry: 'beam-to-beam',
    behavior: 'moment',
    icon: 'bolted-splice-icon',
    defaults: {
      plateThicknessMm: 12,
      boltDiameter: 'M20',
      boltGrade: '8.8',
      boltCount: 16,
      boltRows: 4,
      boltCols: 4,
      weldThicknessMm: 6,
      weldType: 'fillet'
    }
  },
  {
    id: 'gusset-plate',
    name: 'Gusset Plate',
    nameLocal: 'Düğüm Noktası (Gusset)',
    description: 'Connection for diagonal bracing members.',
    descriptionLocal: 'Çapraz bağlantı elemanları için birleşim.',
    geometry: 'brace-to-column',
    behavior: 'axial',
    icon: 'gusset-plate-icon',
    defaults: {
      plateThicknessMm: 15,
      boltDiameter: 'M20',
      boltGrade: '8.8',
      boltCount: 4,
      boltRows: 2,
      boltCols: 2,
      weldThicknessMm: 8,
      weldType: 'fillet'
    }
  },
  {
    id: 'stiffened-end-plate',
    name: 'Stiffened End Plate',
    nameLocal: 'Rijitleştirilmiş Alın Plakalı',
    description: 'Heavy duty moment connection with stiffeners.',
    descriptionLocal: 'Rijitleştiricili ağır hizmet moment birleşimi.',
    geometry: 'beam-to-column',
    behavior: 'moment',
    icon: 'stiffened-end-plate-icon',
    defaults: {
      plateThicknessMm: 25,
      boltDiameter: 'M24',
      boltGrade: '10.9',
      boltCount: 10,
      boltRows: 5,
      boltCols: 2,
      weldThicknessMm: 10,
      weldType: 'butt'
    }
  }
];

/**
 * Returns templates matching the given geometry.
 */
export function getTemplatesForGeometry(geometry: ConnectionGeometry): ConnectionTemplate[] {
  return TEMPLATES.filter(t => t.geometry === geometry);
}

/**
 * Evaluates recommendation for a given template and member profiles.
 */
export function getRecommendation(
  template: ConnectionTemplate,
  memberProfiles: string[]
): { isRecommended: boolean; reason: string; reasonLocal: string } {
  // Simplistic logic for recommendation
  const hasLargeBeam = memberProfiles.some(p => {
    const match = p.match(/(IPE|HE[ABM]|UB|UC)\s*(\d+)/i);
    return match && parseInt(match[2], 10) >= 300;
  });

  if (hasLargeBeam && template.behavior === 'moment') {
    return {
      isRecommended: true,
      reason: 'Recommended for large profiles requiring moment transfer.',
      reasonLocal: 'Moment aktarımı gerektiren büyük profiller için önerilir.'
    };
  }
  
  if (!hasLargeBeam && template.behavior === 'shear') {
    return {
      isRecommended: true,
      reason: 'Ideal for secondary beams and smaller profiles.',
      reasonLocal: 'Tali kirişler ve küçük profiller için idealdir.'
    };
  }

  return {
    isRecommended: false,
    reason: '',
    reasonLocal: ''
  };
}

/**
 * Auto-detect the connection geometry type from selected member IFC classes and
 * relative angles. This is the function the panel calls right after the user
 * picks members in the 3D viewer.
 */
export function detectGeometryType(
  members: Array<{ ifcClass: string; unit: [number, number, number] }>
): ConnectionGeometry {
  if (members.length === 0) return 'beam-to-column';
  if (members.length === 1) return 'base-plate';

  const hasColumn = members.some(m => m.ifcClass.toLowerCase().includes('column'));
  const hasBrace  = members.some(m => m.ifcClass.toLowerCase().includes('member'));
  const hasBeam   = members.some(m => m.ifcClass.toLowerCase().includes('beam'));
  const allBeams  = members.every(m => m.ifcClass.toLowerCase().includes('beam'));

  if (members.length >= 4) return 'multi-member';
  if (allBeams && members.length === 2) return 'beam-to-beam';
  if (hasColumn && hasBrace) return 'brace-to-column';
  if (hasBeam && hasBrace)   return 'brace-to-beam';
  if (hasColumn && hasBeam)  return 'beam-to-column';

  return 'beam-to-column'; // fallback
}

/**
 * Returns templates for a given geometry with recommendation flags populated
 * based on the provided member profiles.
 */
export function getRecommendedTemplates(
  geometry: ConnectionGeometry,
  memberProfiles: string[] = []
): ConnectionTemplate[] {
  const candidates = getTemplatesForGeometry(geometry);
  return candidates.map(t => {
    const rec = getRecommendation(t, memberProfiles);
    return {
      ...t,
      isRecommended: rec.isRecommended,
      recommendationReason: rec.reason,
      recommendationReasonLocal: rec.reasonLocal,
    };
  });
}
