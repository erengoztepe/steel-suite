// Active house-style profile (server/style_profiles/*.json) for the TS side of the pipeline.
//
// The drawing code draws on ROLES ('visible', 'hidden', 'axis', 'bolt', 'text', 'dimension',
// 'hatch', 'cut', ...), never on an office's layer names; server/render.py maps roles to the
// profile's real layers when it writes the DXF. The sizes the TS side lays out with (text height
// ladder, weld-leader arrowhead, section-mark geometry, view-title bubble) come from the same
// profile, so one file defines the whole house style.
//
// Resolution order is shared with server/house_style.py:
//   1. $STEEL_STYLE_PROFILE -- a path, or a profile name in server/style_profiles/
//   2. server/style_profiles/local.json -- your own office style; git-ignored, never committed
//   3. server/style_profiles/default.json -- the neutral ISO style shipped with the repo
// The resolved file is recorded in the spec (meta.styleProfile) so render.py uses the same one.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StyleProfile {
  name: string;
  text_height: { title: number; sub: number; label: number };
  leader_arrow: { label: [number, number]; weld: [number, number] };
  view_title: { bubble_r: number };
  section_mark: { bubble_r: number; arrow_in: number; arrow_out: number; tick_len: number; tick_w: number };
  hatch: { pattern: string; scale: number };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profileDir = resolve(repoRoot, 'server/style_profiles');

function byNameOrPath(v: string): string {
  if (!v.toLowerCase().endsWith('.json')) return resolve(profileDir, `${v}.json`);
  return isAbsolute(v) || existsSync(v) ? resolve(v) : resolve(profileDir, v);
}

function resolveProfile(): string {
  const env = process.env.STEEL_STYLE_PROFILE;
  if (env) {
    const p = byNameOrPath(env);
    if (!existsSync(p)) throw new Error(`STEEL_STYLE_PROFILE=${env}: no such profile (${p})`);
    return p;
  }
  const local = resolve(profileDir, 'local.json');
  return existsSync(local) ? local : resolve(profileDir, 'default.json');
}

const STYLE_FILE = resolveProfile();

/** The active profile. */
export const STYLE: StyleProfile = JSON.parse(readFileSync(STYLE_FILE, 'utf8'));

/** The active profile's path as recorded in the spec: repo-relative when inside the repo. */
export const STYLE_PATH: string = (() => {
  const rel = relative(repoRoot, STYLE_FILE);
  return rel.startsWith('..') || isAbsolute(rel) ? STYLE_FILE : rel.replace(/\\/g, '/');
})();
