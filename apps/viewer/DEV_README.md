# Member Vectors — the IFC viewer app (`apps/viewer`)

Browser-only tool that extracts steel-joint geometry from an IFC (direction
vectors, CPA connection node, per-member offset ex/ey/ez, section rotation,
profiles/stiffness) and exports it for IDEA StatiCa (CSV/TSV or an IDEA Open
Model `.xml`). The extraction itself needs no backend — everything runs in the
browser (web-ifc WASM + the fragments worker are vendored under `public/`).

All of the tool's source lives under `src/` here and the `@` path alias points at
`./src`, so this app builds and runs on its own even though it sits in a monorepo.

## Setup
Install once at the **repo root** (npm workspaces resolves both apps together):
```bash
npm install          # if peer-dep conflicts appear: npm install --legacy-peer-deps
```
Then, from the root:
```bash
npm run dev          # BOTH tools, two tabs, one port  -> http://localhost:5177
npm run dev:viewer   # this viewer alone (Vite)         -> http://localhost:5173
npm run build:viewer # -> apps/viewer/dist/  (static, deployable anywhere)
```
Node 18+ recommended. Do NOT open `dist/index.html` via `file://` — WASM/Web
Workers need http(s); serve it (`npx serve dist`, or any static host) from the
site root.

## Combined mode: this viewer + the DXF drawing tool, two tabs, one port
`dev-server.mts` (this folder) is an Express server that hosts Vite in middleware
mode, so both tools share a single origin with no proxy: `apps/drawgen`'s routes
are imported from its own `src/web/api.ts` and its page is served in place at
`/drawing/`, embedded as an iframe. Nothing is duplicated, so edits on either side
stay live — Vite HMR here, livereload there. `dev:viewer` above is unaffected: no
drawing tab there. Details: `docs/combined-dev-server.md`. Only one dev server can
run at a time (both want ports 5177 + 35729).

## Where things live
- `AppShell.tsx` — two-tab shell (viewer / drawing tool) used in combined mode; renders
  the viewer alone otherwise.
- `dev-server.mts` — the combined dev server (Express + Vite middleware).
- `StandaloneApp.tsx` — app shell: viewer bootstrap, IFC drag-drop/load, mounts
  the control panel + the Member Vectors panel.
- `src/modules/bim-compliance/member-vectors/` — **the tool** (all logic):
  - `extract-member-vectors.ts` — web-ifc extraction: axis vectors, placement
    local axes, geometric (IDEA-convention) rotation, profile + section props.
  - `joint-solver.ts` — CPA least-squares node, close/far, eccentricity.
  - `suggest-bearing-member.ts` — bearing/continuous member detection.
  - `find-connected-members.ts` — node-centric "Joint" auto-add.
  - `member-vectors-panel.tsx` — the right-hand UI panel (table, exports, fullscreen).
  - `joint-diagram.tsx` — isometric schematic. `draw-vectors.ts` — 3D overlay.
  - `emit-iom.ts` — IDEA Open Model (.xml) export. `section-reconciliation.ts` +
    `parse-design-forces.ts` — Excel section check.
- `src/modules/bim-compliance/setupViewer.ts` — ThatOpen viewer/world setup.
- `src/modules/bim-compliance/ProjectDetail/Viewer/control-panel/` — viewer controls.
- `src/components/`, `src/icons/`, `src/styles/globals.css` — reused UI + theme.
- `public/wasm/web-ifc/`, `public/worker.mjs`, `public/draco/` — offline engine assets.

## Key notes / open items
- IFC coords can carry huge geodetic offsets; the IOM export recenters the joint
  node to the origin. web-ifc WASM version (0.0.71) must match `public/wasm/web-ifc/`.
- Verified against Python `ifcopenshell`/numpy ground truth: extraction, CPA node,
  eccentricity, bearing pick, geometric rotation + local offset ex/ey/ez.
- IOM `.xml` export is aligned to a real IDEA StatiCa export (see a captured
  reference): document root `<OpenModelContainer><OpenModel>`, `Version` 3.2.0,
  and per-type field ORDER match IDEA's serializer (it deserializes as an ordered
  sequence — a bare `<OpenModel>`/`Version 1` root failed to open at all).
  Still open: cross-sections are emitted by name only (no parametric dimensions),
  so a member with no resolvable IFC profile name exports as "UNKNOWN" and IDEA
  can't build it; no `LocalCoordinateSystem` on segments yet (rotation via
  `CrossSectionRotation` only); UTF-8 vs IDEA's UTF-16; UK section-name string
  and rotation sign — see `docs/idea-iom-research.md` in the original repo.
- Section/force matching to the analysis Excel is catalog-level only (no shared
  per-element key between IFC and the analysis model — a data/scope dependency).
