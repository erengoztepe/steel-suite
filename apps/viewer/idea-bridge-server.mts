/**
 * Dev-only bridge: IOM XML (POST body) -> design-ready `.ideaCon` (JSON reply),
 * exposed as a Vite plugin so it works in both dev modes (see
 * connection-library-server.mts for the same rationale). `apply: "serve"` — a
 * static bundle has no backend, and the "Export .ideaCon" button is dev-only.
 *
 * It shells out to `tools/idea/iom_to_ideacon.py`, which talks to IDEA StatiCa's
 * Connection REST API (must be running on localhost:5000) and enriches the
 * name-only cross-sections into parametric ones from IDEA's MPRL. So this
 * endpoint needs, on the machine running the dev server: Python (with
 * `ideastatica_connection_api`) + the IDEA REST service running.
 *
 * Wire protocol (client: member-vectors-panel.tsx `downloadIdeaCon`):
 *   POST /api/idea/ideacon?name=<connName>[&baseUrl=<url>]
 *        body: the OpenModelContainer IOM XML ("Export IDEA (.xml)" form)
 *   -> 200 { ok, filename, report, ideaConBase64? }   (ok=false if no file made)
 *   The client shows `report` (the CLI self-check) and, when ok, downloads the
 *   decoded `.ideaCon`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Connect, Plugin } from "vite";

const ROUTE = "/api/idea/ideacon";
const DEFAULT_PYTHON =
  // the Python that has `ideastatica_connection_api` installed; plain `python` on PATH otherwise
  process.env.IDEA_PYTHON || "python";

function readBody(req: Connect.IncomingMessage): Promise<string> {
  const parsed = (req as { body?: unknown }).body;
  if (typeof parsed === "string") return Promise.resolve(parsed);
  if (parsed && typeof parsed === "object") return Promise.resolve(String(parsed));
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
      if (raw.length > 64 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(
  res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  status: number,
  body: unknown,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function safeName(name: string): string {
  return (name || "connection").replace(/[^A-Za-z0-9._ ()-]+/g, "_").slice(0, 120) || "connection";
}

export interface IdeaBridgeOptions {
  /** Absolute path to tools/idea/iom_to_ideacon.py (passed from vite.config so
   *  this bundled module never has to guess its own location). */
  scriptPath: string;
  /** Python executable that has `ideastatica_connection_api` installed. */
  python?: string;
}

export function ideaBridgeApi({ scriptPath, python }: IdeaBridgeOptions): Plugin {
  const py = python || DEFAULT_PYTHON;
  return {
    name: "idea-bridge-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res, next) => {
        if (req.method !== "POST") return next();
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = safeName(url.searchParams.get("name") || "connection");
        const baseUrl = url.searchParams.get("baseUrl") || undefined;

        void (async () => {
          let dir: string | null = null;
          try {
            const xml = await readBody(req);
            if (!xml.includes("<OpenModel")) {
              sendJson(res, 400, { ok: false, error: "body is not IOM Xml (no <OpenModel>)" });
              return;
            }
            dir = mkdtempSync(path.join(tmpdir(), "idea-bridge-"));
            const xmlPath = path.join(dir, `${name}.xml`);
            const outPath = path.join(dir, `${name}.ideaCon`);
            writeFileSync(xmlPath, xml, "utf8");

            const args = [scriptPath, xmlPath, "-o", outPath];
            if (baseUrl) args.push("--base-url", baseUrl);
            const proc = spawnSync(py, args, {
              encoding: "utf8",
              // clean UTF-8 from the CLI's report (avoids cp1252 mojibake)
              env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
              maxBuffer: 64 * 1024 * 1024,
            });
            const report = `${proc.stdout || ""}${proc.stderr || ""}`.trim();
            if (proc.error) {
              sendJson(res, 200, {
                ok: false,
                filename: `${name}.ideaCon`,
                report,
                error: `could not launch Python (${py}): ${proc.error.message}. Set IDEA_PYTHON.`,
              });
              return;
            }
            const made = existsSync(outPath);
            sendJson(res, 200, {
              ok: made,
              filename: `${name}.ideaCon`,
              report,
              ideaConBase64: made ? readFileSync(outPath).toString("base64") : undefined,
            });
          } catch (err) {
            server.config.logger.error(`idea-bridge: ${String(err)}`);
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
          } finally {
            if (dir) {
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                /* best effort */
              }
            }
          }
        })();
      });
    },
  };
}
