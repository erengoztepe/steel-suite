/**
 * Saved Connection Library record -> IOM XML (-> .ideaCon).
 *
 * Reads a `.data/connection-library/<ifc>.json` file (what the viewer's "Save
 * Connection" writes) and, for each saved connection, reconstructs the oriented
 * member rows through the EXACT same path the viewer uses — solveJoint ->
 * anchorNodeToBearing -> buildOrientedRows — then emits the geometry-only IOM
 * container XML via the shared emit-iom module. No logic is duplicated here; this
 * script imports the viewer's own pure modules and runs them under Node/tsx.
 *
 * By default it then chains each XML through `iom_to_ideacon.py` (the REST-API
 * bridge) to produce a design-ready `.ideaCon`. Use --emit-only to stop at XML.
 *
 * RUN (tsx is a devDep of apps/viewer, so run from there so the binary resolves):
 *
 *   cd apps/viewer
 *   npx tsx ../../tools/idea/saved_to_iom.mts <ifc-name-or-json-path> [options]
 *
 * OPTIONS
 *   --name "connection-A"   only the connection(s) whose name matches (exact, else
 *                       case-insensitive substring). Repeatable-ish via commas.
 *   --id <uuid>         only the connection with this id.
 *   --all               all connections in the file (default when no selector).
 *   -o, --out <dir>     output directory (default <repo>/out/idea).
 *   --emit-only         write only the .xml files; skip the .ideaCon conversion.
 *   --python <path>     python.exe to run iom_to_ideacon.py with.
 *   --base-url <url>    REST service base URL (default http://localhost:5000).
 *   --keep-global       keep original global coordinates (default: recenter to
 *                       origin, matching the viewer's "Export IDEA (.xml)").
 *
 * EXAMPLES
 *   npx tsx ../../tools/idea/saved_to_iom.mts my-model --name J-01
 *   npx tsx ../../tools/idea/saved_to_iom.mts ../../.data/connection-library/my-model.json --all
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { solveJoint, anchorNodeToBearing } from "../../apps/viewer/src/modules/bim-compliance/member-vectors/joint-solver";
import { buildOrientedRows } from "../../apps/viewer/src/modules/bim-compliance/member-vectors/build-oriented-rows";
import { emitConnectionIom } from "../../apps/viewer/src/modules/bim-compliance/member-vectors/emit-iom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".data", "connection-library");
// the Python that has `ideastatica_connection_api` installed; plain `python` on PATH otherwise
const DEFAULT_PYTHON = process.env.IDEA_PYTHON || "python";
const CLI_PY = path.join(__dirname, "iom_to_ideacon.py");

// --------------------------------------------------------------------------- //
// Minimal SavedConnection shape (we read JSON; the store module is browser-side
// and must not be imported here).                                              //
// --------------------------------------------------------------------------- //
type Vec3 = [number, number, number];
interface SavedConnection {
  id: string;
  name: string;
  rawRows: any[];
  bearingGlobalId: string | null;
  geomTypeById: [string, "Continuous" | "Ended"][];
  manualFlips: string[];
}
interface LibraryFile {
  ifcName: string;
  connections: SavedConnection[];
}

// --------------------------------------------------------------------------- //
// Tiny arg parser.                                                            //
// --------------------------------------------------------------------------- //
function parseArgs(argv: string[]) {
  const out: {
    input?: string;
    name?: string;
    id?: string;
    all: boolean;
    outDir: string;
    emitOnly: boolean;
    python: string;
    baseUrl?: string;
    keepGlobal: boolean;
  } = {
    all: false,
    outDir: path.join(REPO_ROOT, "out", "idea"),
    emitOnly: false,
    python: DEFAULT_PYTHON,
    keepGlobal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--name") out.name = next();
    else if (a === "--id") out.id = next();
    else if (a === "--all") out.all = true;
    else if (a === "-o" || a === "--out") out.outDir = next();
    else if (a === "--emit-only") out.emitOnly = true;
    else if (a === "--python") out.python = next();
    else if (a === "--base-url") out.baseUrl = next();
    else if (a === "--keep-global") out.keepGlobal = true;
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else if (!out.input) out.input = a;
    else throw new Error(`unexpected extra argument: ${a}`);
  }
  return out;
}

function resolveLibraryFile(input: string | undefined): string {
  if (!input) {
    const files = listLibraryFiles();
    throw new Error(
      "missing <ifc-name-or-json-path>. Available libraries:\n" +
        files.map((f) => "  - " + describeLib(f)).join("\n"),
    );
  }
  // Direct path to a .json?
  if (input.toLowerCase().endsWith(".json") && fs.existsSync(input)) {
    return path.resolve(input);
  }
  const candidate = path.join(LIB_DIR, input.endsWith(".json") ? input : input + ".json");
  if (fs.existsSync(candidate)) return candidate;

  // Match by ifcName field or filename stem (case-insensitive).
  const wanted = input.toLowerCase().replace(/\.ifc$/, "");
  const matches = listLibraryFiles().filter((f) => {
    const stem = path.basename(f, ".json").toLowerCase();
    let ifcName = "";
    try {
      ifcName = (JSON.parse(fs.readFileSync(f, "utf-8")).ifcName || "").toLowerCase().replace(/\.ifc$/, "");
    } catch {
      /* ignore */
    }
    return stem === wanted || ifcName === wanted || stem.includes(wanted) || ifcName.includes(wanted);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const files = listLibraryFiles();
    throw new Error(
      `no connection-library file matches '${input}'. Available:\n` +
        files.map((f) => "  - " + describeLib(f)).join("\n"),
    );
  }
  throw new Error(
    `'${input}' is ambiguous; matches:\n` + matches.map((f) => "  - " + describeLib(f)).join("\n"),
  );
}

function listLibraryFiles(): string[] {
  if (!fs.existsSync(LIB_DIR)) return [];
  return fs
    .readdirSync(LIB_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => path.join(LIB_DIR, f));
}

function describeLib(f: string): string {
  let n = "?";
  let ifc = "?";
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf-8"));
    ifc = d.ifcName || "?";
    n = String((d.connections || []).length);
  } catch {
    /* ignore */
  }
  return `${path.basename(f)}  (ifcName=${ifc}, ${n} connection(s))`;
}

function selectConnections(lib: LibraryFile, opts: ReturnType<typeof parseArgs>): SavedConnection[] {
  const all = lib.connections || [];
  if (opts.id) {
    const c = all.filter((x) => x.id === opts.id);
    if (!c.length) throw new Error(`no connection with id '${opts.id}'.`);
    return c;
  }
  if (opts.name) {
    const wanted = opts.name.toLowerCase();
    let c = all.filter((x) => x.name.toLowerCase() === wanted);
    if (!c.length) c = all.filter((x) => x.name.toLowerCase().includes(wanted));
    if (!c.length) {
      throw new Error(
        `no connection named '${opts.name}'. Available:\n` +
          all.map((x) => `  - ${x.name}`).join("\n"),
      );
    }
    return c;
  }
  return all; // default: all
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, "_").trim() || "connection";
}

// --------------------------------------------------------------------------- //
// Rebuild oriented rows exactly like the viewer, then emit IOM XML.           //
// (Mirror of member-vectors-panel.tsx handleExportLibrary / downloadIom.)     //
// --------------------------------------------------------------------------- //
function emitXmlForConnection(conn: SavedConnection, keepGlobal: boolean): {
  xml: string;
  memberCount: number;
  bearingName: string | null;
  continuous: string[];
} {
  const rows = conn.rawRows as any[];
  const inputs = rows.map((r) => ({
    globalId: r.globalId,
    start: r.start,
    end: r.end,
    unit: r.unit,
    tangentStart: r.tangentStart,
    tangentEnd: r.tangentEnd,
    curve: r.curve,
  }));
  const bearingId = conn.bearingGlobalId ?? rows[0]?.globalId ?? null;
  const geomTypeMap = new Map(conn.geomTypeById);
  const base = solveJoint(inputs as any);
  const endedCloseEnds = base
    ? base.members
        .filter((s) => s.globalId !== bearingId && geomTypeMap.get(s.globalId) === "Ended")
        .map((s) => s.close)
    : [];
  const js = anchorNodeToBearing(inputs as any, bearingId, { endedCloseEnds });
  const orientedRows = buildOrientedRows(rows as any, js, bearingId, geomTypeMap, new Set(conn.manualFlips));
  const continuousIds = new Set(orientedRows.filter((r) => r.isContinuous).map((r) => r.globalId));

  const xml = emitConnectionIom(orientedRows, bearingId, continuousIds, {
    nodeMm: js?.node,
    projectName: conn.name,
    keepGlobalCoordinates: keepGlobal,
  });

  const bearingRow = orientedRows.find((r) => r.globalId === bearingId);
  return {
    xml,
    memberCount: orientedRows.length,
    bearingName: bearingRow ? bearingRow.tag || bearingRow.name || bearingId : bearingId,
    continuous: orientedRows.filter((r) => r.isContinuous).map((r) => r.tag || r.name || r.globalId),
  };
}

// --------------------------------------------------------------------------- //
// Main.                                                                       //
// --------------------------------------------------------------------------- //
function main(): number {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("ERROR:", (e as Error).message);
    return 2;
  }

  let libPath: string;
  try {
    libPath = resolveLibraryFile(opts.input);
  } catch (e) {
    console.error("ERROR:", (e as Error).message);
    return 2;
  }

  const lib: LibraryFile = JSON.parse(fs.readFileSync(libPath, "utf-8"));
  console.log(`Library : ${libPath}`);
  console.log(`ifcName : ${lib.ifcName}`);

  let selected: SavedConnection[];
  try {
    selected = selectConnections(lib, opts);
  } catch (e) {
    console.error("ERROR:", (e as Error).message);
    return 2;
  }
  console.log(`Selected: ${selected.length} connection(s)`);
  fs.mkdirSync(opts.outDir, { recursive: true });

  const xmlPaths: string[] = [];
  for (const conn of selected) {
    if (!conn.rawRows || conn.rawRows.length === 0) {
      console.warn(`  ! '${conn.name}': no rawRows, skipping.`);
      continue;
    }
    try {
      const { xml, memberCount, bearingName, continuous } = emitXmlForConnection(conn, opts.keepGlobal);
      const xmlPath = path.join(opts.outDir, safeFileName(conn.name) + ".xml");
      fs.writeFileSync(xmlPath, xml, "utf-8");
      xmlPaths.push(xmlPath);
      console.log(
        `  + '${conn.name}': ${memberCount} member(s), bearing=${bearingName}, ` +
          `continuous=[${continuous.join(", ")}] -> ${path.basename(xmlPath)}`,
      );
    } catch (e) {
      console.error(`  X '${conn.name}': emit failed: ${(e as Error).message}`);
    }
  }

  if (xmlPaths.length === 0) {
    console.error("No XML produced.");
    return 1;
  }
  console.log(`\nWrote ${xmlPaths.length} IOM XML file(s) to ${opts.outDir}`);

  if (opts.emitOnly) {
    console.log("--emit-only: skipping .ideaCon conversion.");
    return 0;
  }

  // Chain into the Python REST-API bridge: XML(s) -> .ideaCon(s).
  console.log(`\nConverting to .ideaCon via ${path.basename(CLI_PY)} ...`);
  const cliArgs = [CLI_PY, ...xmlPaths, "-o", opts.outDir];
  if (opts.baseUrl) cliArgs.push("--base-url", opts.baseUrl);
  const r = spawnSync(opts.python, cliArgs, { stdio: "inherit" });
  if (r.error) {
    console.error(`ERROR launching python: ${r.error.message}`);
    console.error(`(tried: ${opts.python}; override with --python)`);
    return 2;
  }
  return r.status ?? 1;
}

process.exit(main());
