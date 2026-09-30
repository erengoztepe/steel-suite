/**
 * Extraction routed across SEVERAL loaded IFCs.
 *
 * A structure delivered as separate IFC files (one per zone/phase/trade) has its
 * most interesting joints exactly on the seams between files: the beam is in one
 * file, the column it lands on is in another. Once those files are imported into
 * one viewer, a joint's members no longer share a single set of IFC bytes, so
 * every extraction has to be split per source file and the results merged back
 * into the order the user picked.
 *
 * The wrappers here do only that — grouping, per-file dispatch, merge. All the
 * geometry work stays in `extract-member-vectors.ts`, unchanged and still
 * single-model, so the one-file path produces byte-identical results whether it
 * goes through here or not (a one-file registry degenerates to exactly one
 * `extract*FromBytes` call with the same arguments as before).
 *
 * On GlobalId as the merge key: GlobalIds are unique per element, so the only
 * way one appears in two loaded files is that both files carry the SAME physical
 * element (the overlap an import reports as a clash). Collapsing those to one
 * row is the right answer — it is one member — and whichever file resolves it
 * first supplies the geometry.
 */

import { sourceFor, groupByModel, type IfcSource } from "../ifc-sources";
import {
  extractAllMemberTagsFromBytes,
  extractMemberProfilesByGlobalIdsFromBytes,
  extractMemberVectorsFromBytes,
} from "./extract-member-vectors";
import type { MemberVectorRow } from "./types";

/** A member to extract, together with the loaded model it belongs to. */
export interface MemberTarget {
  globalId: string;
  modelId: string;
}

/**
 * Extract member vectors for targets that may live in different files.
 * Preserves `targets` order and drops members that resolved to nothing, exactly
 * like the single-model `extractMemberVectors` it delegates to.
 */
export async function extractMemberVectorsAcrossModels(
  sources: IfcSource[],
  targets: MemberTarget[],
  options?: { allowBrepFallback?: boolean },
): Promise<MemberVectorRow[]> {
  const byModel = groupByModel(targets);
  const rowsByGlobalId = new Map<string, MemberVectorRow>();

  // Sequential, not parallel: each call spins up its own web-ifc WASM instance
  // and holds the whole file's entity graph, so two large models extracting at
  // once doubles peak memory for no wall-clock gain the user would notice.
  for (const [modelId, group] of byModel) {
    const source = sourceFor(sources, modelId);
    if (!source) continue;
    const rows = await extractMemberVectorsFromBytes(
      new Uint8Array(source.buffer),
      group.map((t) => t.globalId),
      options,
    );
    for (const row of rows) if (!rowsByGlobalId.has(row.globalId)) rowsByGlobalId.set(row.globalId, row);
  }

  return targets
    .map((t) => rowsByGlobalId.get(t.globalId))
    .filter((r): r is MemberVectorRow => r != null)
    // A clashing GlobalId appears once per file in `targets`; keep the first.
    .filter((r, i, all) => all.findIndex((o) => o.globalId === r.globalId) === i);
}

/** Profile-name hints for the selection screen, across files. */
export async function extractMemberProfilesAcrossModels(
  sources: IfcSource[],
  targets: MemberTarget[],
): Promise<Map<string, string>> {
  const byModel = groupByModel(targets);
  const out = new Map<string, string>();
  for (const [modelId, group] of byModel) {
    const source = sourceFor(sources, modelId);
    if (!source) continue;
    const resolved = await extractMemberProfilesByGlobalIdsFromBytes(
      new Uint8Array(source.buffer),
      group.map((t) => t.globalId),
    );
    for (const [globalId, profile] of resolved) if (!out.has(globalId)) out.set(globalId, profile);
  }
  return out;
}

/**
 * Tag → members index spanning every loaded file, for the "go to Tag" jump.
 *
 * Each entry keeps its source `modelId`, because a Tag is only unique within one
 * file: two files of the same structure can legitimately reuse a Tag for
 * different members, and the caller needs to know which model to resolve a hit
 * against rather than searching all of them.
 */
export async function buildTagIndexAcrossModels(sources: IfcSource[]): Promise<Map<string, MemberTarget[]>> {
  const index = new Map<string, MemberTarget[]>();
  for (const source of sources) {
    const entries = await extractAllMemberTagsFromBytes(new Uint8Array(source.buffer));
    for (const entry of entries) {
      if (!entry.tag) continue;
      const target: MemberTarget = { globalId: entry.globalId, modelId: source.modelId };
      const existing = index.get(entry.tag);
      if (existing) existing.push(target);
      else index.set(entry.tag, [target]);
    }
  }
  return index;
}
