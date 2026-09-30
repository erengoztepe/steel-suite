// Prints the view PLAN for an IOM: which views, why each exists, what each carries, and what is
// left uncovered. A debugging/auditing entry point -- run it on a known connection to check the
// planner against the sheet you expect it to produce.
//
// Run: npx tsx src/drawing/planreport.ts <iom.xml>

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadIom } from '../ingest/iom.ts';
import { planViews, requiredInfo, candidateDirections, type Archetype } from './viewplan.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../../..');   // apps/drawgen/src/drawing -> repo root
const iomPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(root, 'fixtures/fin_plate.iom.xml');

const m = loadIom(iomPath);
const grid = m.boltGrids[0];
const archetype: Archetype = grid && grid.connectedParts.length > 1
  && grid.connectedParts.every((c) => /plate/i.test(c.type)) ? 'end-plate' : 'fin-plate';
const bearing = m.members.find((mm) => mm.isBearing && mm.section)
  ?? m.members.find((mm) => mm.section);

const nearest = (): { x: number; y: number; z: number } => {
  if (!bearing?.axis) return { x: 0, y: 0, z: 0 };
  const a = bearing.axis.start, b = bearing.axis.end;
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const l = Math.hypot(d.x, d.y, d.z) || 1;
  const u = { x: d.x / l, y: d.y / l, z: d.z / l };
  const t = -(a.x * u.x + a.y * u.y + a.z * u.z);
  return { x: a.x + u.x * t, y: a.y + u.y * t, z: a.z + u.z * t };
};

const f3 = (v: { x: number; y: number; z: number }) =>
  `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

console.log(`\n=== ${iomPath.split(/[\\/]/).pop()} ===`);
console.log(`archetype: ${archetype}   bearing: ${bearing?.name ?? '(none)'}`);
console.log(`members: ${m.members.map((x) => `${x.name}[${x.section?.name ?? '?'}]`).join(', ')}`);
console.log(`plates: ${m.plates.filter((p) => !p.isNegative).map((p) => `${p.name}@${p.thickness}`).join(', ')}`);
console.log(`bolt grids: ${m.boltGrids.length}   welds: ${m.welds.length}`);

console.log(`\n-- model's candidate view directions --`);
for (const c of candidateDirections(m)) console.log(`   ${f3(c.dir)}  ${c.why}`);

console.log(`\n-- information the drawing must carry (${requiredInfo(m).length} items) --`);
for (const it of requiredInfo(m)) console.log(`   ${it.id.padEnd(34)} ${it.what}`);

const plan = planViews(m, archetype, bearing, nearest());

console.log(`\n-- PLAN: ${plan.views.length} views --`);
for (const v of plan.views) {
  const tag = v.role === 'main' ? 'MAIN' : v.role === 'iso' ? 'ISO ' : 'SECT';
  console.log(`   [${tag}] ${v.name}${v.addedByCoverage ? '  (added by coverage)' : ''}`);
  console.log(`          normal ${f3(v.normal)}${v.parent ? `   mark drawn in: ${v.parent}` : ''}`);
  console.log(`          carries: ${v.covers.length ? v.covers.join(', ') : '(nothing measured)'}`);
}

console.log(`\n-- coverage --`);
for (const c of plan.coverage) {
  console.log(`   ${c.views.length ? 'OK  ' : 'GAP '} ${c.what.padEnd(50)} ${c.views.join(', ')}`);
}

console.log(`\n-- flags --`);
for (const f of plan.flags) console.log(`   ${f.severity.padEnd(6)} ${f.code}: ${f.message}`);
console.log();
