import { Router } from 'express';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Monorepo root is 3 levels up from apps/viewer/src/server
const rootDir = resolve(__dirname, '../../../..');

function runPython(scriptName: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    // Run the python script located at server/<scriptName> in the root
    const scriptPath = resolve(rootDir, 'server', scriptName);
    const child = spawn('python', [scriptPath, ...args], { cwd: rootDir });
    
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    
    child.on('error', (e) => resolvePromise({ code: 1, out: err + String(e) }));
    child.on('close', (code) => {
      if (err) {
        console.error(`[${scriptName} stderr]:`, err);
      }
      resolvePromise({ code: code ?? 1, out });
    });
  });
}

export function createViewerApi(): Router {
  const router = Router();

  router.post('/api/optimize', async (req, res) => {
    const { projectId, connectionId, parameter, range, direction } = req.body;

    if (!projectId || connectionId === undefined || !parameter || !range) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }

    try {
      const args = [
        '--project-id', String(projectId),
        '--conn-id', String(connectionId),
        '--parameter', String(parameter),
        '--range', String(range),
        '--direction', String(direction || 'DECREASING')
      ];

      const { code, out } = await runPython('optimizer.py', args);
      
      if (code !== 0) {
        res.status(500).json({ error: 'Optimizer script failed', details: out });
        return;
      }

      try {
        const result = JSON.parse(out);
        if (result.error) {
          res.status(400).json({ error: result.error });
        } else {
          res.json(result);
        }
      } catch (parseError) {
        res.status(500).json({ error: 'Failed to parse optimizer output', details: out });
      }

    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  router.post('/api/standardization', async (req, res) => {
    const { folderPath } = req.body;

    if (!folderPath) {
      res.status(400).json({ error: 'Missing folderPath parameter' });
      return;
    }

    try {
      const args = ['--dir', String(folderPath)];
      const { code, out } = await runPython('standardizer.py', args);
      
      if (code !== 0) {
        res.status(500).json({ error: 'Standardizer script failed', details: out });
        return;
      }

      try {
        const result = JSON.parse(out);
        if (result.error) {
          res.status(400).json({ error: result.error });
        } else {
          res.json(result);
        }
      } catch (parseError) {
        res.status(500).json({ error: 'Failed to parse standardizer output', details: out });
      }

    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  router.post('/api/start-idea-api', async (req, res) => {
    try {
      const fs = await import('node:fs');
      const basePath = 'C:\\Program Files\\IDEA StatiCa';
      const versions = ['StatiCa 26.0', 'StatiCa 25.0', 'StatiCa 24.0'];
      let exePath = '';
      
      for (const ver of versions) {
        const testPath = resolve(basePath, ver, 'IdeaStatiCa.ConnectionRestApi.exe');
        if (fs.existsSync(testPath)) {
          exePath = testPath;
          break;
        }
      }

      if (!exePath) {
        res.status(404).json({ error: 'Could not find IdeaStatiCa.ConnectionRestApi.exe in standard locations.' });
        return;
      }

      const child = spawn(exePath, ['-port', '5000'], { detached: true, stdio: 'ignore' });
      child.unref();
      res.json({ success: true, message: `API started at ${exePath}` });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  return router;
}
