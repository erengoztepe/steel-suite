/**
 * The viewer's look-and-feel choices — per-model tint and scene background —
 * kept across launches.
 *
 * localStorage, not the IndexedDB store next door: these are a handful of short
 * strings, and unlike the IFC bytes they must be readable SYNCHRONOUSLY during
 * the first render, so the viewer never flashes the default background before
 * settling on the chosen one.
 *
 * Tint values are `#rrggbb` (older builds stored palette names; see
 * `resolveTintValue`, which migrates them on read).
 *
 * Tints are keyed by FILE NAME, not modelId. A modelId carries a uniquifying
 * suffix assigned in load order within a session (see `uniqueModelId`), so it is
 * not stable across launches; the file name is also what the persisted session
 * records, so the two line up on restore. Two different files that share a name
 * consequently share a tint — the same trade the Connection Library already
 * makes with its own file-name key.
 *
 * Every access is wrapped: localStorage throws outright in a blocked-cookies or
 * private-window context, and an appearance preference must never be able to
 * stop the viewer from opening.
 */

const STORAGE_KEY = "member-vectors:appearance";

export interface Appearance {
  /** `SceneBackground.key`, or undefined to use the default. */
  background?: string;
  /**
   * The two gradient stops behind `background === "custom"`. Kept even while a
   * preset is selected, so switching back to Custom returns to the colours the
   * user mixed rather than to a default.
   */
  customBackground?: { top: string; bottom: string };
  /** fileName -> colour (`#rrggbb`). Absent file = untinted. */
  tints?: Record<string, string>;
}

const isStopPair = (v: unknown): v is { top: string; bottom: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { top?: unknown }).top === "string" &&
  typeof (v as { bottom?: unknown }).bottom === "string";

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Appearance;
    // Hand-edited or older-format values reach this code as `any`. Unknown keys
    // are resolved leniently downstream (`findSceneBackground` falls back to the
    // default, `applyModelTints` skips an unregistered tint), so shape is all
    // that has to be checked here.
    if (typeof parsed !== "object" || parsed === null) return {};
    return {
      background: typeof parsed.background === "string" ? parsed.background : undefined,
      customBackground: isStopPair(parsed.customBackground) ? parsed.customBackground : undefined,
      tints: typeof parsed.tints === "object" && parsed.tints !== null ? parsed.tints : undefined,
    };
  } catch {
    return {};
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage unavailable or full — the choice still applies to this session.
  }
}
