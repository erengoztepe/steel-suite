/**
 * Registry of the raw IFC byte buffers behind the models currently in the
 * viewer, keyed by the fragments `modelId`.
 *
 * Why the raw bytes are kept at all, and why PER MODEL: every extractor in this
 * app (member vectors, plate outlines, the Tag index, the profile hints) re-opens
 * the ORIGINAL IFC in its own web-ifc model rather than reading the fragments
 * geometry — fragments keeps triangles, not the IFC entity graph the extractors
 * need (Axis curves, property sets, swept-solid profiles).
 *
 * A single shared buffer was enough while the viewer held one model at a time.
 * It stops being enough the moment a second file is imported alongside the
 * first: a GlobalId from file B is simply not present in file A's bytes, so an
 * extraction pointed at the wrong buffer does NOT fail loudly — it returns
 * nothing for that member and the member quietly drops out of the result. So
 * every extraction has to be routed to the buffer its member actually came from,
 * which is what this registry exists for.
 */

/** One loaded IFC: the fragments model it became, plus the bytes it came from. */
export interface IfcSource {
  /**
   * Fragments model id. `IfcLoader.load(bytes, coordinate, name)` passes `name`
   * straight through as the modelId, so this is the name the file was loaded
   * under — uniquified (see `uniqueModelId`) when two files share a base name.
   */
  modelId: string;
  /** The file name as the user picked it, before any uniquifying suffix. */
  fileName: string;
  buffer: ArrayBuffer;
  /** True for the first file loaded — the one every other file is coordinated against. */
  isBase: boolean;
}

/** The host's live view of the registry, passed down to the extraction UIs. */
export type GetIfcSources = () => IfcSource[];

/** The buffer a given model's members must be extracted from, or null if unknown. */
export function sourceFor(sources: IfcSource[], modelId: string): IfcSource | null {
  return sources.find((s) => s.modelId === modelId) ?? null;
}

/** The first-loaded file — the Connection Library key and the coordination base. */
export function baseSource(sources: IfcSource[]): IfcSource | null {
  return sources.find((s) => s.isBase) ?? sources[0] ?? null;
}

/**
 * A modelId that has never been used in this session.
 *
 * Two separate reasons it can't just be the file name:
 *
 *  1. Fragments keys its model map by modelId, so importing a second file whose
 *     name matches a loaded one would collide with (and could replace) the
 *     first. Both files are legitimately importable — the same base name in two
 *     folders is ordinary — so the later one gets a suffix, not a rejection.
 *
 *  2. `taken` must keep every id EVER issued, not just the currently-loaded
 *     ones, so a freed name is never handed back. Several caches around the
 *     viewer are keyed `modelId:localId` and outlive a model —
 *     `resolvedCacheRef` in use-member-selection, the tag-label identity/box
 *     caches, the Tag index's cache key, and the modelIds inside saved
 *     Connection Library records. Recycling a name makes those keys collide
 *     across two DIFFERENT files: unmount `part2.ifc`, re-export it, import the
 *     new `part2.ifc`, and a cache answers with the OLD file's globalId for the
 *     new file's localId — which extraction then resolves to nothing and drops
 *     the member, silently. Non-recycling ids kill that whole class at once.
 *
 * The suffix is internal: the UI, the Connection Library key and the persisted
 * session all use `fileName`, so the user never sees it.
 */
export function uniqueModelId(taken: Iterable<string>, fileName: string): string {
  const used = new Set(taken);
  if (!used.has(fileName)) return fileName;
  for (let i = 2; ; i++) {
    const candidate = `${fileName} (${i})`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Group a flat list of per-member targets by the model each belongs to, so one
 * web-ifc model can be opened per file instead of once per member.
 */
export function groupByModel<T extends { modelId: string }>(targets: T[]): Map<string, T[]> {
  const byModel = new Map<string, T[]>();
  for (const t of targets) {
    const existing = byModel.get(t.modelId);
    if (existing) existing.push(t);
    else byModel.set(t.modelId, [t]);
  }
  return byModel;
}
