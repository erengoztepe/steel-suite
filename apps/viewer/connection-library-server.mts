/**
 * Disk-backed store for the Connection Library, exposed as a Vite dev plugin.
 *
 * Why on disk and not just localStorage: localStorage is scoped to the browser
 * profile + origin, so the saved connections die on "clear site data", on a
 * different browser or port, and on the ~5MB quota (each saved connection
 * carries its full rawRows). Connections are hours of picking work — they
 * belong in the repo's own data dir, where they survive everything the browser
 * does and can be backed up or inspected by hand.
 *
 * It's a VITE PLUGIN rather than an express route in dev-server.mts so ONE
 * implementation serves both dev modes: `npm run dev` (Vite in middleware mode
 * inside the combined express server) and `npm run dev:viewer` (plain Vite).
 * `apply: "serve"` — a static production bundle has no backend, and the client
 * store falls back to localStorage there.
 *
 * Wire protocol (client: src/modules/bim-compliance/member-vectors/connection-library-store.ts):
 *   GET  /api/connection-library?ifc=<name>   -> { connections: [...] }
 *   PUT  /api/connection-library?ifc=<name>   <- { connections: [...] }   (whole list)
 * The whole list is replaced on every write: the client always holds the
 * complete library for one IFC, so there is no partial update to merge and no
 * lost-update window between two panels editing different files.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

const ROUTE = "/api/connection-library";

interface LibraryFile {
  /** The raw IFC file name this library belongs to. Kept so a sanitized
   *  filename collision between two different IFC names is detected (treated
   *  as a miss) instead of silently serving the wrong library. */
  ifcName: string;
  connections: unknown[];
}

/** Map an IFC file name to a readable, filesystem-safe basename. */
function libraryFileName(ifcName: string): string {
  const safe = ifcName
    .replace(/\.ifc$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  return `${safe || "unnamed"}.json`;
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  // In the combined dev server express.json() runs before Vite's middlewares,
  // so the body is already parsed and the stream is drained; in plain Vite
  // nothing has touched it yet. Handle both.
  const parsed = (req as { body?: unknown }).body;
  if (parsed && typeof parsed === "object") return Promise.resolve(JSON.stringify(parsed));
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      // A library is JSON text; anything this large is a bug or an attack, not
      // a user's connections.
      if (raw.length > 64 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // Never let a dev proxy or the browser cache a library read.
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export interface ConnectionLibraryApiOptions {
  /** Absolute path of the directory holding one JSON file per IFC. Passed in
   *  by vite.config.mts so this module never has to guess its own location
   *  (Vite bundles config imports, which makes __dirname/import.meta.url here
   *  unreliable). */
  dataDir: string;
}

export function connectionLibraryApi({ dataDir }: ConnectionLibraryApiOptions): Plugin {
  const filePathFor = (ifcName: string) => path.join(dataDir, libraryFileName(ifcName));

  const read = (ifcName: string): unknown[] => {
    const file = filePathFor(ifcName);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LibraryFile;
    if (parsed.ifcName !== ifcName) return []; // sanitized-name collision
    return Array.isArray(parsed.connections) ? parsed.connections : [];
  };

  const write = (ifcName: string, connections: unknown[]) => {
    mkdirSync(dataDir, { recursive: true });
    const file = filePathFor(ifcName);
    // Write-then-rename: a crash mid-write must not truncate a library that
    // took hours of member picking to build.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ifcName, connections } satisfies LibraryFile, null, 2), "utf8");
    renameSync(tmp, file);
    return file;
  };

  return {
    name: "connection-library-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res, next) => {
        // Mounted on ROUTE, so req.url is the remainder ("/?ifc=..."); the
        // query is all we use.
        const url = new URL(req.url ?? "/", "http://localhost");
        const ifcName = url.searchParams.get("ifc");
        if (!ifcName) {
          sendJson(res, 400, { error: "missing ?ifc=<file name>" });
          return;
        }

        void (async () => {
          try {
            if (req.method === "GET") {
              sendJson(res, 200, { ifcName, connections: read(ifcName) });
              return;
            }
            if (req.method === "PUT") {
              const body = JSON.parse((await readBody(req)) || "{}") as { connections?: unknown };
              if (!Array.isArray(body.connections)) {
                sendJson(res, 400, { error: "body must be { connections: [...] }" });
                return;
              }
              const file = write(ifcName, body.connections);
              server.config.logger.info(
                `connection library: ${body.connections.length} saved for ${ifcName} -> ${path.relative(process.cwd(), file)}`,
              );
              sendJson(res, 200, { ifcName, count: body.connections.length });
              return;
            }
            next();
          } catch (err) {
            server.config.logger.error(`connection library: ${String(err)}`);
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    },
  };
}
