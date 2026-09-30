"""Extract house-style conventions from a DXF: layouts, layers, styles, blocks,
annotations, view layout. Reusable across the sample set.

Usage: python tools/analyze_dxf.py <file.dxf>
"""
from __future__ import annotations
import sys
from collections import Counter, defaultdict
from pathlib import Path
import ezdxf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import house_style as hs  # noqa: E402

if len(sys.argv) < 2:
    print("usage: python tools/analyze_dxf.py <file.dxf>", file=sys.stderr)
    sys.exit(2)
p = sys.argv[1]
hs.load()   # active style profile: maps the file's real layer names back to roles
doc = ezdxf.readfile(p)
print(f"# {p}")
print(f"dxfversion={doc.dxfversion} ({doc.acad_release})  insunits={doc.header.get('$INSUNITS')}")

print("\n## Layouts (entity type counts)")
for lay in doc.layouts:
    c = Counter(e.dxftype() for e in lay)
    if sum(c.values()):
        print(f"  [{lay.name}] {dict(c.most_common())}")

print("\n## Layers (name | color | linetype | lineweight)")
for l in sorted(doc.layers, key=lambda x: x.dxf.name):
    print(f"  {l.dxf.name:22} c={l.dxf.color:>3} lt={getattr(l.dxf,'linetype','?'):12} lw={getattr(l.dxf,'lineweight','?')}")

print("\n## Text styles")
for s in doc.styles:
    print(f"  {s.dxf.name:22} font={getattr(s.dxf,'font','')!r} big={getattr(s.dxf,'bigfont','')!r} h={getattr(s.dxf,'height',0)}")

print("\n## Dim styles (key vars)")
for d in doc.dimstyles:
    g = lambda k: d.get_dxf_attrib(k, None)
    print(f"  {d.dxf.name}: txt={g('dimtxt')} asz={g('dimasz')} scale={g('dimscale')} "
          f"tad={g('dimtad')} tih={g('dimtih')} dec={g('dimdec')} lunit={g('dimlunit')} "
          f"exe={g('dimexe')} exo={g('dimexo')} clrt={g('dimclrt')}")

print("\n## Blocks (name | entity counts | insert refs)")
insert_counts = Counter()
for lay in doc.layouts:
    for e in lay.query('INSERT'):
        insert_counts[e.dxf.name] += 1
for b in doc.blocks:
    if b.name.startswith('*'):  # anonymous/model/paper
        pass
    c = Counter(e.dxftype() for e in b)
    if sum(c.values()):
        print(f"  {b.name:24} refs={insert_counts.get(b.name,0):>3}  {dict(c.most_common(8))}")

print("\n## Entity counts by (layer, type) across all layouts")
by = defaultdict(Counter)
for lay in doc.layouts:
    for e in lay:
        by[e.dxf.layer][e.dxftype()] += 1
for layer in sorted(by):
    print(f"  {layer:22} {dict(by[layer].most_common(8))}")

print("\n## All TEXT/MTEXT strings (layer :: text)")
seen = []
for lay in doc.layouts:
    for e in lay:
        if e.dxftype() == 'TEXT':
            seen.append((e.dxf.layer, e.dxf.text.strip()))
        elif e.dxftype() == 'MTEXT':
            seen.append((e.dxf.layer, e.text.replace('\n', ' ').strip()))
for layer, t in seen:
    if t:
        print(f"  {layer:18} :: {t[:80]}")

print("\n## Model-space view clustering (infer separate views)")
from ezdxf import bbox as _bbox
msp = doc.modelspace()
items = []  # (cx, cy, w, h, layer, type)
for e in msp:
    try:
        bb = _bbox.extents([e])
        cx = (bb.extmin.x + bb.extmax.x) / 2
        cy = (bb.extmin.y + bb.extmax.y) / 2
        items.append([cx, cy, bb.size.x, bb.size.y, e.dxf.layer, e.dxftype(), e])
    except Exception:
        pass
# union-find clustering by proximity
THRESH = 500.0
parent = list(range(len(items)))
def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]; i = parent[i]
    return i
def union(a, b):
    parent[find(a)] = find(b)
for i in range(len(items)):
    xi, yi = items[i][0], items[i][1]
    for j in range(i + 1, len(items)):
        if abs(xi - items[j][0]) < THRESH and abs(yi - items[j][1]) < THRESH:
            union(i, j)
groups = defaultdict(list)
for i in range(len(items)):
    groups[find(i)].append(i)
clusters = sorted(groups.values(), key=len, reverse=True)
print(f"  {len([c for c in clusters if len(c) >= 5])} view-clusters (>=5 ents), THRESH={THRESH}mm")
for ci, idxs in enumerate([c for c in clusters if len(c) >= 5][:8]):
    xs = [items[i][0] for i in idxs]; ys = [items[i][1] for i in idxs]
    lays = Counter(items[i][4] for i in idxs)
    # nearby view-title texts
    titles = [items[i][6].dxf.text.strip() for i in idxs
              if items[i][5] == 'TEXT' and items[i][6].dxf.text.strip()]
    print(f"  view#{ci}: {len(idxs)} ents  bbox=({min(xs):.0f},{min(ys):.0f})..({max(xs):.0f},{max(ys):.0f}) "
          f"WxH={max(xs)-min(xs):.0f}x{max(ys)-min(ys):.0f}")
    print(f"      layers={dict(lays.most_common(6))}")
    if titles:
        print(f"      texts={titles[:8]}")

print("\n## Sample annotation (dimension/label) text values (numbers)")
dimtexts = []
for e in msp:
    if e.dxftype() == 'TEXT' and hs.role_of(e.dxf.layer) in ("text", "dimension"):
        t = e.dxf.text.strip()
        if t:
            dimtexts.append((round(e.dxf.height, 2), t))
print(f"  {len(dimtexts)} annotation texts; sample:", dimtexts[:25])
