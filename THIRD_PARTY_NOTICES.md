# Third-party notices

steel-suite's own source code is licensed under the MIT License (see `LICENSE`).
It builds on the open-source components below, which remain under their own licenses.

## Files redistributed in this repository

These binaries/bundles are committed unmodified so the viewer runs fully offline.

| Path | Component | License | Source |
|---|---|---|---|
| `apps/viewer/public/wasm/web-ifc/` | web-ifc (IFC parser, WebAssembly) | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |
| `apps/viewer/public/draco/` | Draco 3D geometry decoder | Apache-2.0 | https://github.com/google/draco |
| `apps/viewer/public/worker.mjs` | @thatopen/fragments worker (includes pako, MIT AND Zlib) | MIT | https://github.com/ThatOpen/engine_fragment |

The MPL-2.0 files are unmodified; their source code is available at the link above.

## npm dependencies (installed, not committed)

Production dependencies are all under permissive licenses (MIT, ISC, Apache-2.0,
BSD-3-Clause, Unlicense, MIT AND Zlib), except:

- **web-ifc** — MPL-2.0 (file-level copyleft; used unmodified)
- **jszip** — dual-licensed "MIT OR GPL-3.0-or-later"; used under MIT
- **xlsx** (SheetJS Community Edition) — Apache-2.0

Main direct dependencies: `@thatopen/components`, `@thatopen/components-front`,
`@thatopen/fragments`, `three`, `camera-controls`, `react`, `react-dom`, `recharts`,
`express`, `multer`, `fast-xml-parser`, `polygon-clipping`, `classnames` (MIT);
`web-ifc` (MPL-2.0); `xlsx` (Apache-2.0).

## Python dependencies (installed, not committed)

| Package | License |
|---|---|
| ezdxf | MIT |
| ifcopenshell | LGPL-3.0-or-later (imported as a library, not modified or bundled) |
| numpy, scipy, shapely | BSD |
| matplotlib | PSF-based matplotlib license |
| requests | Apache-2.0 |

## Optional proprietary integration

`tools/idea/` and the viewer's ".ideaCon" export talk to IDEA StatiCa through its
Connection REST API and the `ideastatica_connection_api` Python package. Those are
IDEA StatiCa products under IDEA StatiCa's own license; they are **not** included in
this repository and must be installed separately by users who hold a license.
