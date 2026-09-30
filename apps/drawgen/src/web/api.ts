// The drawing tool's HTTP surface, as a mountable Express router: IOM(.xml)+IFC(.ifc)
// upload -> runs the existing build:spec + render.py pipeline unchanged -> DXF download.
//
// Split out of server.ts so the exact same routes can be served either by this app's own
// dev server (server.ts, `npm run dev:drawgen`) or by the combined two-tab dev server in
// apps/viewer, which imports this file directly. Neither copy of the code, nor of the
// frontend under public/ — one source, two hosts.
//
// Every path here is resolved from this file's own location, so a host that mounts the
// router from another directory (a different cwd) still hits the right pipeline.
import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../apps/drawgen/src/web -> app dir, then the monorepo root (which owns samples/,
// output/ and the python pipeline under server/).
const appDir = resolve(__dirname, '../..');
const root = resolve(appDir, '../..');
const tmpRoot = resolve(appDir, 'tmp');

/** The drawing tool's frontend (index.html). Hosts serve this statically. */
export const drawingPublicDir = resolve(__dirname, 'public');
/** Where DXFs land when the user hasn't picked an output folder. */
export const defaultOutputDir = resolve(root, 'output');
/** Directories the livereload watcher should follow for drawing-tool edits. */
export const drawingWatchDirs = [drawingPublicDir, resolve(appDir, 'src')];

mkdirSync(tmpRoot, { recursive: true });
mkdirSync(defaultOutputDir, { recursive: true });

const isWin = process.platform === 'win32';

// "name.dxf" -> "name.dxf" if free, else "name (1).dxf", "name (2).dxf", ...
function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = basename(name, ext);
  let candidate = join(dir, name);
  for (let n = 1; existsSync(candidate); n++) {
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    // Only `npx` needs a shell on Windows (it's a .cmd shim); real .exes
    // (python, powershell) get args as a literal array, no cmd.exe re-quoting
    // — important since the /browse script arg has embedded quotes/newlines.
    const child = spawn(cmd, args, { cwd, shell: isWin && cmd === 'npx' });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (err) => resolvePromise({ code: 1, out: out + String(err) }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

/**
 * Routes: GET /config, POST /browse, POST /generate, GET /download.
 * Mount at the same prefix the frontend fetches from (root, today).
 */
export function createDrawingApi(): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

  router.get('/config', (_req, res) => {
    res.json({ defaultOutputDir });
  });

  // Native OS folder-browse dialog. Only makes sense because this server and
  // the browser run on the same local machine (a local dev tool, not hosted).
  router.post('/browse', async (req, res) => {
    if (!isWin) {
      res.status(501).json({ error: 'Klasör seçme diyaloğu şu an yalnız Windows üzerinde destekleniyor.' });
      return;
    }
    const startDir = String(req.body?.currentDir ?? '');
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = 'Çıktı klasörünü seç'
      if ('${startDir.replace(/'/g, "''")}' -and (Test-Path '${startDir.replace(/'/g, "''")}')) {
        $dialog.SelectedPath = '${startDir.replace(/'/g, "''")}'
      }
      $result = $dialog.ShowDialog()
      if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dialog.SelectedPath
      }
    `;
    const { code, out } = await run('powershell', ['-NoProfile', '-Sta', '-Command', script], appDir);
    const path = out.trim();
    if (code !== 0 || !path) {
      res.json({ cancelled: true });
      return;
    }
    res.json({ path });
  });

  router.post('/generate', upload.array('files', 2), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const iomFile = files.find((f) => /\.xml$/i.test(f.originalname));
    const ifcFile = files.find((f) => /\.ifc$/i.test(f.originalname));

    if (!iomFile || !ifcFile) {
      res.status(400).json({ error: 'Bir .xml (IOM) ve bir .ifc dosyası birlikte gerekli.' });
      return;
    }

    const requestedDir = String(req.body?.outputDir ?? '').trim();
    const outputDir = requestedDir ? resolve(requestedDir) : defaultOutputDir;
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (e: any) {
      res.status(400).json({ error: `Çıktı klasörü oluşturulamadı: ${outputDir}\n${e?.message ?? e}` });
      return;
    }

    const jobId = randomUUID();
    const workDir = join(tmpRoot, jobId);
    mkdirSync(workDir, { recursive: true });

    try {
      // Same basename for both, per the build.ts convention (x.xml <-> x.ifc).
      const base = basename(iomFile.originalname, extname(iomFile.originalname));
      const iomPath = join(workDir, `${base}.xml`);
      const ifcPath = join(workDir, `${base}.ifc`);
      const specPath = join(workDir, 'spec.json');
      const dxfPath = join(workDir, `${base}.dxf`);
      const pngPath = join(workDir, `${base}.png`);

      writeFileSync(iomPath, iomFile.buffer);
      writeFileSync(ifcPath, ifcFile.buffer);

      // Unit base for the produced DXF (see DrawingSpec.meta.units). Validated here rather than
      // trusted: it reaches a child-process argv, and an unrecognised value would otherwise fail
      // deep inside render.py with a less obvious message.
      const units = String(req.body?.units ?? 'mm').trim().toLowerCase();
      if (units !== 'mm' && units !== 'cm') {
        res.status(400).json({ error: `Bilinmeyen birim: ${units}. 'mm' veya 'cm' olmalı.` });
        return;
      }

      const step1 = await run('npx', ['tsx', 'src/drawing/build.ts', iomPath, specPath, `--units=${units}`], appDir);
      if (step1.code !== 0 || !existsSync(specPath)) {
        res.status(500).json({ error: 'IOM işleme (build:spec) başarısız.', log: step1.out });
        return;
      }

      const step2 = await run('python', ['server/render.py', specPath, dxfPath, pngPath], root);
      if (step2.code !== 0 || !existsSync(dxfPath)) {
        res.status(500).json({ error: 'DXF render başarısız.', log: step1.out + '\n' + step2.out });
        return;
      }

      const finalDxfPath = uniquePath(outputDir, `${base}.dxf`);
      copyFileSync(dxfPath, finalDxfPath);
      rmSync(workDir, { recursive: true, force: true });

      res.json({ ok: true, outputPath: finalDxfPath, file: basename(finalDxfPath), units });
    } catch (e: any) {
      rmSync(workDir, { recursive: true, force: true });
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // Separate step: download a file already produced by /generate (path comes
  // from that response's outputPath, so it may live in any chosen output dir).
  router.get('/download', (req, res) => {
    const p = String(req.query.path ?? '');
    if (!p || !/\.dxf$/i.test(p) || !existsSync(p)) {
      res.status(404).json({ error: 'Dosya bulunamadı.' });
      return;
    }
    res.download(resolve(p), basename(p));
  });

  return router;
}
