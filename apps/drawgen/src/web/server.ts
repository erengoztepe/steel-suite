// Dev server for the drawing tool ALONE: the routes from api.ts plus the static frontend
// under public/.
// Run: npm run dev:drawgen  (from the repo root), then open http://localhost:5177
//
// The combined two-tab app (IFC viewer + this tool on one localhost) does NOT go through
// here — apps/viewer/dev-server.mts mounts the same api.ts router. Only one of the two
// can run at a time; both want :5177 and livereload's :35729. See
// docs/combined-dev-server.md.
import express from 'express';
import livereload from 'livereload';
import connectLivereload from 'connect-livereload';
import { createDrawingApi, drawingPublicDir, drawingWatchDirs } from './api';

// Dev-only: browser auto-reloads when public/ (frontend) or src/ (backend,
// restarted separately by `tsx watch`) changes on disk.
const lrServer = livereload.createServer({ exts: ['html', 'js', 'ts', 'css'] });
lrServer.watch(drawingWatchDirs);

const app = express();
app.use(connectLivereload());
app.use(express.json());
// etag/lastModified off: dev-only server, and 304s would serve stale cached
// HTML from before the livereload script was ever injected.
app.use(express.static(drawingPublicDir, { etag: false, lastModified: false, cacheControl: false }));
app.use(createDrawingApi());

const port = Number(process.env.PORT ?? 5177);
app.listen(port, () => console.log(`web UI: http://localhost:${port}`));
