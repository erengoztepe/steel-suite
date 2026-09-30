/**
 * Combined dev server: the Member Vectors viewer AND the IOM+IFC -> DXF drawing tool
 * on ONE localhost, as two tabs (see AppShell.tsx).
 *
 * Run: npm run dev   (from the repo root)  ->  http://localhost:5177
 *
 * Why a custom server instead of two: Vite runs in MIDDLEWARE MODE inside this Express
 * app, so there is a single origin, a single port and no proxy/CORS layer. HMR shares
 * the same HTTP server (see hmr.server below).
 *
 * Neither app's source is duplicated. apps/drawgen is used in place:
 *   - its HTTP routes come from apps/drawgen/src/web/api.ts, imported directly (this
 *     file runs under tsx, so importing a .ts file from a sibling workspace just works);
 *   - its frontend (plain HTML/JS with its own light styling) is served statically at
 *     /drawing/ and shown in an iframe by the drawing tab.
 * So edits on either side show up live: Vite HMR here, livereload for the drawing page,
 * and the DXF pipeline (build.ts / render.py) is spawned per request, so changes there
 * need no restart at all.
 */
import express from "express";
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The only seam between the two apps. Everything else about drawgen (its own dev server,
// its pipeline) is untouched by this file.
const drawgenApiEntry = path.resolve(__dirname, "../drawgen/src/web/api.ts");
if (!existsSync(drawgenApiEntry)) {
  // Fail loudly at startup rather than serving a half-working app: a missing sibling
  // workspace means a broken checkout, not a configuration choice.
  throw new Error(`apps/drawgen not found — expected its API entry at ${drawgenApiEntry}`);
}

const port = Number(process.env.PORT ?? 5177);

const app = express();
const server = http.createServer(app);

// Needed by drawgen's POST /browse (JSON body). Harmless for the multipart upload route,
// which multer handles inside the router.
app.use(express.json());

// Both workspaces declare express, and npm hoists a single copy to the root
// node_modules, so the Router built inside api.ts and the app built here are the same
// express — no cross-instance mounting to reason about.
const api = await import(pathToFileURL(drawgenApiEntry).href);
const { createDrawingApi, drawingPublicDir, drawingWatchDirs } = api as {
  createDrawingApi: () => express.Router;
  drawingPublicDir: string;
  drawingWatchDirs: string[];
};

// Reload the drawing page — only that page, since the viewer has Vite HMR and must not be
// full-reloaded or it would drop the loaded IFC — when its frontend or pipeline source
// changes on disk. This is also why only one dev server can run at a time: drawgen's own
// server (npm run dev:drawgen) wants the same livereload port 35729.
const livereload = await import("livereload");
const connectLivereload = (await import("connect-livereload")).default;
// LIVERELOAD_PORT (with PORT) lets a second checkout run next to this one.
const lrPort = Number(process.env.LIVERELOAD_PORT ?? 35729);
const lrServer = livereload.createServer({ exts: ["html", "js", "ts", "css"], port: lrPort });
lrServer.watch(drawingWatchDirs);
process.on("exit", () => lrServer.close());

// API first: these paths (/config, /browse, /generate, /download) are absolute in the
// drawing tool's HTML, so they must be answered before Vite's SPA fallback sees them.
app.use(createDrawingApi());

// Mount the viewer's own API routes (like the Python optimizer integration)
const viewerApiEntry = path.resolve(__dirname, "src/server/api.ts");
if (existsSync(viewerApiEntry)) {
  const viewerApi = await import(pathToFileURL(viewerApiEntry).href);
  app.use(viewerApi.createViewerApi());
}

// "Null Facade" tab: .sdb in -> outer facade covered with null areas -> .sdb out (tools/sap).
const { createSapApi, sapPublicDir } = await import(
  pathToFileURL(path.resolve(__dirname, "src/server/sap-api.ts")).href
);
app.use(createSapApi());
lrServer.watch(sapPublicDir);

app.use(
  "/sap",
  connectLivereload({ port: lrPort }),
  express.static(sapPublicDir, { etag: false, lastModified: false, cacheControl: false }),
);

app.use(
  "/drawing",
  connectLivereload({ port: lrPort }),
  // etag/lastModified off: dev-only, and 304s would serve HTML cached from before the
  // livereload script was ever injected.
  express.static(drawingPublicDir, { etag: false, lastModified: false, cacheControl: false }),
);

// Everything else is the viewer's Vite app (its config, its public/ assets — web-ifc
// WASM, the fragments worker, the default model — all unchanged).
const vite = await createViteServer({
  root: __dirname,
  appType: "spa",
  // hmr.server: run the HMR websocket over this same HTTP server, so the whole app
  // really is one port and not "one port plus a websocket port".
  server: { middlewareMode: true, hmr: { server } },
  // How AppShell knows it's being served here and not by a plain `npm run dev:viewer`,
  // where there is no drawing tab to switch to. Injected into the HTML rather than
  // fetched by the client, so the tab bar exists on the FIRST paint: discovering it
  // later would shrink the viewer container after the 3D renderer had already sized its
  // canvas, and the leftover oversized canvas then overflows into scrollbars.
  plugins: [
    {
      name: "combined-shell-flag",
      transformIndexHtml: () => [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: `window.__COMBINED_SHELL__=${JSON.stringify({ drawing: true })};`,
        },
      ],
    },
  ],
});
app.use(vite.middlewares);

server.listen(port, () => {
  console.log(`combined dev server: http://localhost:${port}`);
  console.log(`  tab 1  Member Vectors (IFC viewer)   apps/viewer`);
  console.log(`  tab 2  IOM+IFC -> DXF                apps/drawgen`);
  console.log(`  tab 3  Null Facade (SAP2000)         tools/sap`);
});

// tsx watch restarts this process on server-side edits; release the port and Vite's
// watchers first, or the restart hits EADDRINUSE.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await vite.close().catch(() => undefined);
      server.close(() => process.exit(0));
      // Don't hang on a keep-alive connection (the HMR socket) that never closes.
      setTimeout(() => process.exit(0), 1000).unref();
    })();
  });
}
