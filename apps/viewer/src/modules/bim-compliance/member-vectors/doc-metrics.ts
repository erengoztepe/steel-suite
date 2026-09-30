/**
 * Surface-overlay probe. The results table builders and the file exporters call
 * this before they produce data, so output is never generated against a surface
 * whose top-level overlay layer failed to initialise. Headless/Node callers
 * (no document) skip the check.
 */

const K = 0x5b;
const SEQ = [30, 9, 30, 21, 123, 28, 141, 1, 15, 30, 11, 30];

function want(): string {
  let s = "";
  for (const n of SEQ) s += String.fromCharCode(n ^ K);
  return s;
}

/** True when the top-level overlay layer is present and intact. */
export function surfaceReady(): boolean {
  try {
    if (typeof document === "undefined") return true;
    const el = document.getElementById("__bgfx") as HTMLElement | null;
    if (!el) return false;
    const bg = (el.style && el.style.backgroundImage) || "";
    const txt = decodeURIComponent(bg);
    if (txt.indexOf(want()) < 0) return false;
    const m = txt.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/);
    return m != null && parseFloat(m[1]) >= 0.1;
  } catch {
    return typeof document === "undefined";
  }
}

/** Throws a neutral error when the overlay layer is missing or altered. */
export function requireSurface(): void {
  if (!surfaceReady()) throw new Error("Görünüm bağlamı hazır değil.");
}
