import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

import { connectionLibraryApi } from "./connection-library-server.mts";
import { ideaBridgeApi } from "./idea-bridge-server.mts";

/**
 * Standalone Member Vectors tool — a self-contained static bundle that reuses the
 * app's modules from ../src via the "@" alias. No auth. Serve the built dist/
 * from a static host (e.g. `npx serve dist`); web-ifc WASM and the fragments
 * worker are vendored under public/ and fetched from the site root.
 *
 * The one dev-only backend is the Connection Library store (`apply: "serve"`),
 * which persists saved connections to <repo>/.data/ instead of localStorage. It
 * lives here rather than in dev-server.mts so it is present in BOTH dev modes —
 * the combined server loads this config too (Vite merges its inline plugins
 * with the ones here).
 */
export default defineConfig({
  root: __dirname,
  base: "/",
  plugins: [
    react(),
    connectionLibraryApi({ dataDir: path.resolve(__dirname, "../../.data/connection-library") }),
    ideaBridgeApi({ scriptPath: path.resolve(__dirname, "../../tools/idea/iom_to_ideacon.py") }),
  ],
  resolve: {
    // Self-contained: the tool's source lives under ./src (copied from the app).
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    proxy: {
      '/idea-api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/idea-api/, ''),
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            if (req.method === 'POST' && (req as any).body) {
              const bodyData = JSON.stringify((req as any).body);
              proxyReq.setHeader('Content-Type', 'application/json');
              proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
              proxyReq.write(bodyData);
            }
          });
        }
      },
    }
  }
});
