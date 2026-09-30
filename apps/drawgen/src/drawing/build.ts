// Loads the slice IOM, builds the elevation DrawingSpec, writes it to out/spec.json.
// Run: npm run build:spec  (from the repo root)

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { loadIom } from '../ingest/iom.ts';
import { rotateModel, rotationMatrix } from '../ingest/rotate.ts';
import { buildDrawing, type BoltDims } from './views.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../../..');   // apps/drawgen/src/drawing -> repo root
// IOM path from argv[2] (relative to cwd), else the default slice; optional out path argv[3].
const iomPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(root, 'fixtures/fin_plate.iom.xml');
const outDir = resolve(root, 'apps/drawgen/out');
const outPath = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : resolve(outDir, 'spec.json');

// Standard bolt/nut/washer geometry DB: shank_d -> {s, e, k, m, washerThickness}. Families are
// consulted in JSON declaration order, FIRST WINS per diameter -- bolts.json lists the ISO
// 4014/4032 STANDARD series first, so it is the default glyph dimension (M16 across-flats
// 24, not the EN 14399 heavy-hex series' 27). A preloaded/HR/HV
// structural assembly should prefer the heavy series instead; per-assembly grade-aware
// selection is a follow-up once a connection using one actually appears.
function loadBoltDims(): BoltDims {
  const map: BoltDims = new Map();
  try {
    const db = JSON.parse(readFileSync(resolve(root, 'server/data/bolts.json'), 'utf8'));
    for (const fam of Object.values<any>(db)) {
      if (/F3125|ASTM/i.test(String(fam.family ?? ''))) continue; // metric only for now
      for (const it of fam.items ?? []) {
        const d = Math.round(it.dims?.shank_d);
        if (d && !map.has(d)) {
          map.set(d, {
            s: it.dims.s, e: it.dims.e, k: it.dims.k, m: it.dims.m,
            washerThickness: it.dims.washer_thickness,
          });
        }
      }
    }
  } catch { /* DB optional */ }
  return map;
}

// --rotate: feed the SAME connection at a fixed oblique orientation (rotation-invariance test).
// The drawing must come out identical under the rotation-invariant signature; if it doesn't,
// something depends on global axes instead of features (pipeline-doctrine §5).
const rotate = process.argv.includes('--rotate');
let model = loadIom(iomPath);
let ifcTransform: number[] | undefined;
if (rotate) {
  const R = rotationMatrix(37, 1, 2, 3);   // fixed, non-axis-aligned, deterministic
  model = rotateModel(model, R);
  ifcTransform = R;                        // Python rotates the IFC mesh by the same R
}

// --units mm|cm: the output document's unit base (default mm). The spec itself is always in
// canonical millimetres; server/render.py applies the base as one scale factor. See DrawingSpec.
const unitsArg = process.argv.find((a) => a.startsWith('--units='))?.split('=')[1];
if (unitsArg && unitsArg !== 'mm' && unitsArg !== 'cm') {
  console.error(`unknown --units=${unitsArg}; expected mm or cm`);
  process.exit(1);
}
const units = (unitsArg ?? 'mm') as 'mm' | 'cm';

// --title-style bubble|underline: how each view announces itself (see DrawingSpec.meta.viewTitle).
// 'bubble' = every view numbered + bubbled; 'underline' = underlined plain caption.
const tsArg = process.argv.find((a) => a.startsWith('--title-style='))?.split('=')[1];
if (tsArg && tsArg !== 'bubble' && tsArg !== 'underline') {
  console.error(`unknown --title-style=${tsArg}; expected bubble or underline`);
  process.exit(1);
}
const titleStyle = (tsArg ?? 'bubble') as 'bubble' | 'underline';

const spec = { ...buildDrawing(model, loadBoltDims(), units, titleStyle), ...(ifcTransform ? { ifcTransform } : {}) };

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8');

console.log(`spec written: ${outPath}`);
console.log(`  unit base: 1 unit = 1 ${units}   view titles: ${titleStyle}`);
console.log(`  entities: ${spec.entities.length}`);
const counts = spec.entities.reduce<Record<string, number>>((a, e) => {
  a[e.type] = (a[e.type] ?? 0) + 1; return a;
}, {});
console.log(`  by type: ${JSON.stringify(counts)}`);
