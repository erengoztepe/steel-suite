// Verifies IOM extraction on the vertical-slice connection.
// Run: npm run verify  (from the repo root)

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadIom } from './iom.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/drawgen/src/ingest -> repo root, which owns fixtures/
const samplePath = resolve(__dirname, '../../../../fixtures/fin_plate.iom.xml');

const m = loadIom(samplePath);
const r1 = (n: number) => Math.round(n * 10) / 10;
const v = (p: { x: number; y: number; z: number }) => `(${r1(p.x)}, ${r1(p.y)}, ${r1(p.z)})`;

console.log(`\n=== ${m.projectName}  [${m.countryCode}]  units=${m.units} ===`);
console.log(`source: ${m.source}\n`);

console.log(`Cross-sections (${m.crossSections.length}):`);
for (const cs of m.crossSections) {
  const p = cs.params;
  console.log(`  #${cs.id} ${cs.name} [${cs.type}]  B=${r1(p.B)} H=${r1(p.H)} tw=${r1(p.s)} tf=${r1(p.t)} r=${r1(p.r2)}`);
}

console.log(`\nBolt assemblies (${m.boltAssemblies.length}):`);
for (const a of m.boltAssemblies) {
  console.log(`  #${a.id} "${a.name}"  d=${r1(a.diameter)} hole=${r1(a.borehole)} grade=${a.grade}`);
}

console.log(`\nMembers (${m.members.length}):`);
for (const mem of m.members) {
  const sec = mem.section ? `${mem.section.name}` : '(no section)';
  console.log(`  #${mem.id} ${mem.name}  bearing=${mem.isBearing}  section=${sec}  cuts=${mem.cuts.length}`);
  if (mem.axis) console.log(`       axis: ${v(mem.axis.start)} -> ${v(mem.axis.end)}`);
  else console.log(`       axis: (unresolved)`);
  if (mem.sectionFrame) console.log(`       section vy=${v(mem.sectionFrame.vy)} vz=${v(mem.sectionFrame.vz)}`);
}

const realPlates = m.plates.filter((p) => !p.isNegative);
const negPlates = m.plates.filter((p) => p.isNegative);
console.log(`\nPlates (${m.plates.length} total: ${realPlates.length} real, ${negPlates.length} negative/cut):`);
for (const p of m.plates) {
  const tag = p.isNegative ? 'NEG ' : 'real';
  console.log(`  [${tag}] #${p.id} ${p.name} (${p.originalId})  t=${r1(p.thickness)}  mat=${p.material}  outlinePts=${p.outline.length}`);
  console.log(`         origin=${v(p.lcs.origin)}  n=${v(p.lcs.az)}`);
}

console.log(`\nBolt grids (${m.boltGrids.length}):`);
for (const g of m.boltGrids) {
  console.log(`  #${g.id}  bolts=${g.positions.length}  ${g.assembly ? `${g.assembly.name} (d=${r1(g.assembly.diameter)})` : '(no assembly)'}  len=${r1(g.length)}`);
  console.log(`       connects: ${g.connectedParts.map((c) => `${c.type}#${c.id}`).join(', ')}`);
  console.log(`       positions: ${g.positions.map(v).join('  ')}`);
}

console.log(`\nWelds (${m.welds.length}):`);
for (const w of m.welds) {
  const len = r1(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y, w.end.z - w.start.z));
  console.log(`  #${w.id} ${w.type} a=${r1(w.thickness)} len=${len}  ${w.name}`);
  console.log(`       parts=[${w.connectedPartIds.join(', ')}]  ${v(w.start)} -> ${v(w.end)}`);
}

// milestone assertions
const problems: string[] = [];
if (realPlates.length !== 1) problems.push(`expected 1 real plate (fin plate), got ${realPlates.length}`);
if (m.boltGrids.length !== 1) problems.push(`expected 1 bolt grid, got ${m.boltGrids.length}`);
if (m.boltGrids[0]?.positions.length !== 6) problems.push(`expected 6 bolts, got ${m.boltGrids[0]?.positions.length}`);
if (!m.boltGrids[0]?.assembly) problems.push(`bolt grid assembly did not resolve`);
if (m.welds.length !== 3) problems.push(`expected 3 welds, got ${m.welds.length}`);
if (m.members.length !== 2) problems.push(`expected 2 members, got ${m.members.length}`);
if (m.crossSections.length !== 2) problems.push(`expected 2 cross-sections, got ${m.crossSections.length}`);
if (m.plates.some((p) => p.outline.length < 3)) problems.push(`a plate has < 3 outline points`);
if (m.members.some((mem) => !mem.section)) problems.push(`a member has no matched section`);

console.log('\n=== milestone check ===');
if (problems.length === 0) console.log('OK: all extraction checks passed ✓');
else { console.log('FAIL:'); problems.forEach((p) => console.log('  - ' + p)); process.exitCode = 1; }
