import { useEffect, useState } from "react";

import StandaloneApp from "./StandaloneApp";

/**
 * Tab shell over the tools that share this dev server (see dev-server.mts):
 *
 *   - "Member Vectors" — the IFC viewer / geometry extractor, this repo's React app.
 *   - "IOM+IFC → DXF"  — the drawing tool, which lives in its OWN repo and is served
 *     in place at /drawing/. It's plain HTML/JS with its own (light) styling, so it's
 *     embedded as an iframe rather than ported into React: nothing is duplicated, and
 *     edits in that repo show up here directly (its own livereload reloads the frame).
 *   - "Null Facade"    — upload a SAP2000 .sdb, cover its outer facade with null areas,
 *     download it. Plain HTML styled like the drawing page, iframe at /sap/
 *     (src/server/sap-public/, backend src/server/sap-api.ts).
 *
 * The tab bar appears only when the page is served BY that combined server, which says so
 * through window.__COMBINED_SHELL__, injected into the HTML. Under a plain `npm run dev`
 * (Vite alone) the flag is absent and the viewer renders alone, exactly as before — which
 * it must, since there /drawing/ would hit Vite's SPA fallback and the iframe would load
 * this very app inside itself.
 *
 * The flag is read synchronously, NOT fetched: asking the server would land the tab bar a
 * round-trip after mount, and that late 34px of layout shift shrinks the viewer container
 * after the 3D renderer has already sized its canvas from it. The oversized canvas then
 * overflows into scrollbars, which shrink the container again.
 *
 * Both panes stay MOUNTED once opened and are hidden with `visibility` rather than
 * `display: none`, on purpose:
 *   - the viewer would otherwise re-initialise (WASM + IFC reload) on every tab switch,
 *     and a display:none container reports a 0×0 size to the renderer's resize observer,
 *     leaving a collapsed canvas when it comes back;
 *   - the drawing tab keeps its picked files, output folder and status text.
 * The cost is that the hidden viewer keeps rendering — fine for a local dev tool.
 */

type TabId = "viewer" | "drawing" | "sap";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "viewer", label: "Member Vectors", hint: "IFC viewer — joint geometry extraction" },
  { id: "drawing", label: "IOM+IFC → DXF", hint: "Detail drawing from IDEA StatiCa export" },
  { id: "sap", label: "Null Facade", hint: "Cover the outer facade of a SAP2000 frame model with null areas" },
];

const COMBINED = Boolean((window as { __COMBINED_SHELL__?: { drawing: boolean } }).__COMBINED_SHELL__);

export default function AppShell() {
  const [active, setActive] = useState<TabId>("viewer");
  // The drawing pane is created on first visit only — no reason to load that page (or
  // let its livereload client connect) before it's asked for. Once created it stays.
  const [drawingMounted, setDrawingMounted] = useState(false);
  const [sapMounted, setSapMounted] = useState(false);
  useEffect(() => {
    if (active === "drawing") setDrawingMounted(true);
    if (active === "sap") setSapMounted(true);
  }, [active]);

  return (
    // overflow-hidden: this shell owns the whole viewport, and nothing inside it should
    // ever be able to produce a scrollbar — a scrollbar would take height away from the
    // viewer pane, which is the input the 3D canvas sizes itself from.
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary text-text-primary">
      {COMBINED && (
        <nav className="flex shrink-0 items-stretch gap-1 border-b border-border-primary bg-bg-primary px-2">
          {TABS.map((tab) => {
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                type="button"
                title={tab.hint}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActive(tab.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-brand-primary text-text-primary"
                    : "border-transparent text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0"
          style={{ visibility: active === "viewer" ? "visible" : "hidden" }}
        >
          <StandaloneApp />
        </div>

        {COMBINED && drawingMounted && (
          <iframe
            src="/drawing/"
            title="IOM+IFC → DXF"
            // bg-white: the embedded page is light-themed and doesn't paint a background
            // itself, so without this the dark shell shows through behind its text.
            className="absolute inset-0 h-full w-full border-0 bg-white"
            style={{ visibility: active === "drawing" ? "visible" : "hidden" }}
          />
        )}

        {COMBINED && sapMounted && (
          <iframe
            src="/sap/"
            title="Null Facade"
            className="absolute inset-0 h-full w-full border-0 bg-white"
            style={{ visibility: active === "sap" ? "visible" : "hidden" }}
          />
        )}
      </div>
    </div>
  );
}
