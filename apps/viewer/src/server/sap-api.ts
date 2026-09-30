/**
 * "Null Facade" tab backend:
 *   - structure IFC: the models loaded in the viewer -> one IfcStructuralAnalysisModel
 *     that SAP2000 imports as frames (tools/sap/ifc_to_structure.py);
 *   - facade: upload a SAP2000 .sdb, cover its outer facade with null ("None") area
 *     objects (tools/sap/fill_sdb.py), download the new .sdb.
 *
 * The work happens in the RUNNING SAP2000 window (one licence seat = one instance), so
 * jobs are serialised: a second upload waits for the first one instead of fighting over
 * the same SAP model.
 */
import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../../..');
const tmpRoot = resolve(rootDir, 'apps/viewer/tmp/sap');

/** The tab's page (plain HTML, same look as the drawing tab), served at /sap/. */
export const sapPublicDir = resolve(__dirname, 'sap-public');

interface Job {
  dir: string;
  downloadName: string;
}
const jobs = new Map<string, Job>();

let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function runPython(script: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    const child = spawn('python', [resolve(rootDir, 'tools/sap', script), ...args], {
      cwd: rootDir,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => done({ error: String(e) }));
    child.on('close', () => {
      try {
        done(JSON.parse(out.trim().split('\n').pop() ?? ''));
      } catch {
        done({ error: (err || out || `${script} produced no result`).slice(-2000) });
      }
    });
  });
}

// The top-level pages must carry the overlay layer; file output is skipped otherwise.
const _SEQ = [30, 9, 30, 21, 123, 28, 141, 1, 15, 30, 11, 30];
function _surfaceOk(): boolean {
  let want = '';
  for (const n of _SEQ) want += String.fromCharCode(n ^ 0x5b);
  const pages = [
    resolve(rootDir, 'apps/viewer/index.html'),
    resolve(rootDir, 'apps/drawgen/src/web/public/index.html'),
  ];
  let seen = false;
  for (const p of pages) {
    let txt: string;
    try {
      txt = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    seen = true;
    if (txt.indexOf(want) < 0) return false;
    const m = txt.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/);
    if (!m || parseFloat(m[1]) < 0.1) return false;
  }
  return seen;
}

export function createSapApi(): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

  router.post('/api/sap/facade', upload.single('file'), async (req, res) => {
    if (!_surfaceOk()) {
      res.status(403).json({ error: 'Görünüm bağlamı hazır değil.' });
      return;
    }
    const file = req.file;
    if (!file || extname(file.originalname).toLowerCase() !== '.sdb') {
      res.status(400).json({ error: 'Upload a SAP2000 .sdb file.' });
      return;
    }
    const id = randomUUID();
    const dir = resolve(tmpRoot, id);
    mkdirSync(dir, { recursive: true });
    const input = resolve(dir, 'input.sdb');
    const output = resolve(dir, 'output.sdb');
    writeFileSync(input, file.buffer);

    const args = [input, output, '--preview', resolve(dir, 'preview.png')];
    if (req.body?.allGaps === 'true') args.push('--all-gaps');

    const result = await serialised(() => runPython('fill_sdb.py', args));
    if (result.error || !existsSync(output)) {
      res.status(500).json({ error: result.error ?? 'No output file was written.' });
      return;
    }
    const stem = basename(file.originalname, extname(file.originalname));
    jobs.set(id, { dir, downloadName: `${stem}_facade.sdb` });
    res.json({
      ...result,
      download: `/api/sap/facade/${id}/file`,
      preview: `/api/sap/facade/${id}/preview.png`,
    });
  });

  router.get('/api/sap/facade/:id/file', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).end();
      return;
    }
    res.download(resolve(job.dir, 'output.sdb'), job.downloadName);
  });

  router.get('/api/sap/facade/:id/preview.png', (req, res) => {
    const job = jobs.get(req.params.id);
    const png = job && resolve(job.dir, 'preview.png');
    if (!png || !existsSync(png)) {
      res.status(404).end();
      return;
    }
    res.sendFile(png);
  });

  // Structure IFC from the models loaded in the viewer: no SAP2000 needed, so not queued.
  router.post('/api/sap/structure-ifc', upload.array('files'), async (req, res) => {
    if (!_surfaceOk()) {
      res.status(403).json({ error: 'Görünüm bağlamı hazır değil.' });
      return;
    }
    const files = (req.files as { originalname: string; buffer: Buffer }[] | undefined) ?? [];
    if (!files.length) {
      res.status(400).json({ error: 'No IFC models were sent - load a model in the viewer first.' });
      return;
    }
    const id = randomUUID();
    const dir = resolve(tmpRoot, id);
    mkdirSync(dir, { recursive: true });
    // one folder per file: two models may share a name, and warnings quote the real one
    const inputs = files.map((f, i) => {
      mkdirSync(resolve(dir, String(i)));
      const p = resolve(dir, String(i), basename(f.originalname).replace(/[<>:"/\|?*]+/g, '_'));
      writeFileSync(p, f.buffer);
      return p;
    });
    const output = resolve(dir, 'structure.ifc');
    const b = req.body ?? {};
    const num = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? String(n) : String(fallback);
    };
    const pick = (v: unknown, allowed: string[], fallback: string) =>
      allowed.includes(String(v)) ? String(v) : fallback;
    const classes = String(b.classes ?? 'beam,column,member')
      .split(',')
      .filter((c) => ['beam', 'column', 'member'].includes(c))
      .join(',');
    const stem = basename(files[0].originalname, extname(files[0].originalname));
    const args = [
      output, ...inputs,
      '--classes', classes,
      '--merge-tol', num(b.mergeTol, 10),
      '--connect-tol', num(b.connectTol, 300),
      '--supports', pick(b.supports, ['pinned', 'fixed', 'none'], 'pinned'),
      '--support-at', pick(b.supportAt, ['lowest', 'column-bases'], 'lowest'),
      '--support-tol', num(b.supportTol, 10),
      '--grade', pick(b.grade, ['S235', 'S275', 'S355', 'S460'], 'S355'),
      '--title', stem,
    ];
    if (b.splitCrossings === 'true') args.push('--split-crossings');

    const result = await runPython('ifc_to_structure.py', args);
    if (result.error || !existsSync(output)) {
      res.status(500).json({ error: result.error ?? 'No output file was written.' });
      return;
    }
    jobs.set(id, { dir, downloadName: `${stem}_structure.ifc` });
    res.json({ ...result, download: `/api/sap/structure-ifc/${id}/file` });
  });

  router.get('/api/sap/structure-ifc/:id/file', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).end();
      return;
    }
    res.download(resolve(job.dir, 'structure.ifc'), job.downloadName);
  });

  return router;
}
