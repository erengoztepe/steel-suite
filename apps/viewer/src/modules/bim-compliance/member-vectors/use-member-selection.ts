/**
 * Tracks the viewer's current beam/column selection as an *ordered* list.
 *
 * The Highlighter fires `onHighlight` with the full current selection map on
 * every (shift-)click; JS Sets don't give a reliable cross-model order, so we
 * diff against the previous list and append newly-selected members in the order
 * they appear. Order matters: it drives the continuous/ended sign convention.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Components, FragmentsManager } from "@thatopen/components";
import { Highlighter } from "@thatopen/components-front";

export interface SelectedMember {
  modelId: string;
  localId: number;
  globalId: string;
  tag: string;
  name: string;
  ifcClass: string;
}

/** Shared with plate-dxf's selection hook — same `_category`/`Name`/`GlobalId` attribute unwrapping. */
export function extractValue(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw === "object" && "value" in raw) {
    return extractValue((raw as Record<string, unknown>).value);
  }
  return "";
}

async function resolveMembers(
  components: Components,
  modelIdMap: Record<string, Set<number>>,
): Promise<SelectedMember[]> {
  const fragmentsManager = components.get(FragmentsManager);
  const out: SelectedMember[] = [];

  for (const [modelId, localIds] of Object.entries(modelIdMap)) {
    const model = fragmentsManager.list.get(modelId);
    if (!model || !localIds || localIds.size === 0) continue;
    const ids = Array.from(localIds);

    let itemsMap: Map<number, any> | undefined;
    let dataArr: any[] | undefined;
    try {
      itemsMap = await model.getItems(ids);
    } catch {
      itemsMap = undefined;
    }
    try {
      dataArr = await model.getItemsData(ids, { attributesDefault: true });
    } catch {
      dataArr = undefined;
    }

    ids.forEach((localId, i) => {
      const entry = itemsMap?.get(localId);
      const data = dataArr?.[i];
      const ifcClass = entry?.category || extractValue(data?._category) || "";
      // Beams, columns & members (e.g. braces/struts modeled as IfcMember) are relevant to the tool.
      if (ifcClass && !/beam|column|member/i.test(ifcClass)) return;
      out.push({
        modelId,
        localId,
        globalId: entry?.guid || extractValue(data?._guid) || extractValue(data?.GlobalId),
        tag: extractValue(data?.Tag),
        name: entry?.data?.Name ? extractValue(entry.data.Name.value) : extractValue(data?.Name),
        ifcClass,
      });
    });
  }
  return out;
}

/** Resolve members by GlobalId (e.g. from a spatial connectivity search) within one model. */
export async function resolveMembersByGlobalIds(
  components: Components,
  modelId: string,
  globalIds: string[],
): Promise<SelectedMember[]> {
  if (globalIds.length === 0) return [];
  const fragmentsManager = components.get(FragmentsManager);
  const model = fragmentsManager.list.get(modelId);
  if (!model) return [];

  const localIds = await model.getLocalIdsByGuids(globalIds);
  const ids = localIds.filter((id): id is number => id != null);
  if (ids.length === 0) return [];

  return resolveMembers(components, { [modelId]: new Set(ids) });
}

/**
 * Resolve a single member by GlobalId without knowing which loaded model it
 * belongs to — tries every currently-loaded model. Used by the "go to tag"
 * lookup, which starts from a bare Tag/GlobalId with no prior selection to
 * infer a modelId from.
 */
export async function resolveMemberByGlobalIdAnyModel(
  components: Components,
  globalId: string,
): Promise<SelectedMember | null> {
  const fragmentsManager = components.get(FragmentsManager);
  for (const modelId of fragmentsManager.list.keys()) {
    const resolved = await resolveMembersByGlobalIds(components, modelId, [globalId]);
    if (resolved.length > 0) return resolved[0];
  }
  return null;
}

function memberKey(modelId: string, localId: number): string {
  return `${modelId}:${localId}`;
}

export function useMemberSelection(components: Components, active: boolean) {
  const [members, setMembers] = useState<SelectedMember[]>([]);
  const membersRef = useRef<SelectedMember[]>([]);
  membersRef.current = members;
  // Permanent per-member cache so already-resolved members are never re-fetched.
  const resolvedCacheRef = useRef<Map<string, SelectedMember>>(new Map());
  // Guards against out-of-order async resolutions across rapid successive clicks.
  const callIdRef = useRef(0);

  const clearSelection = useCallback(async () => {
    try {
      await components.get(Highlighter).clear("select");
    } catch {
      // ignore
    }
    resolvedCacheRef.current.clear();
    setMembers([]);
  }, [components]);

  useEffect(() => {
    if (!active) return;
    const highlighter = components.get(Highlighter);
    let cleanup: (() => void) | null = null;

    const onHighlight = (modelIdMap: Record<string, Set<number>>) => {
      const callId = ++callIdRef.current;

      const presentKeys: string[] = [];
      const toResolve: Record<string, Set<number>> = {};
      for (const [modelId, localIds] of Object.entries(modelIdMap)) {
        for (const localId of localIds) {
          const key = memberKey(modelId, localId);
          presentKeys.push(key);
          if (!resolvedCacheRef.current.has(key)) {
            (toResolve[modelId] ??= new Set()).add(localId);
          }
        }
      }
      const presentSet = new Set(presentKeys);

      const commit = () => {
        // A newer click superseded this resolution — discard to avoid stomping fresher state.
        if (callId !== callIdRef.current) return;
        const prevOrder = membersRef.current;
        const kept = prevOrder.filter((m) => presentSet.has(memberKey(m.modelId, m.localId)));
        const keptKeys = new Set(kept.map((m) => memberKey(m.modelId, m.localId)));
        const added: SelectedMember[] = [];
        for (const key of presentKeys) {
          if (keptKeys.has(key)) continue;
          const cached = resolvedCacheRef.current.get(key);
          if (cached) {
            added.push(cached);
            keptKeys.add(key);
          }
        }
        setMembers([...kept, ...added]);
      };

      if (Object.keys(toResolve).length === 0) {
        commit();
        return;
      }
      resolveMembers(components, toResolve).then((resolved) => {
        for (const m of resolved) resolvedCacheRef.current.set(memberKey(m.modelId, m.localId), m);
        commit();
      });
    };
    const onClear = () => setMembers([]);

    const subscribe = () => {
      const selectEvents = highlighter.events?.select;
      if (!selectEvents) return;
      selectEvents.onHighlight.add(onHighlight);
      selectEvents.onClear.add(onClear);
      cleanup = () => {
        selectEvents.onHighlight.remove(onHighlight);
        selectEvents.onClear.remove(onClear);
      };
      // Seed from any current selection.
      const selectName = highlighter.config?.selectName ?? "select";
      const current = highlighter.selection?.[selectName];
      if (current && Object.keys(current).length > 0) onHighlight(current);
    };

    if (highlighter.isSetup) subscribe();
    const onSetup = () => subscribe();
    highlighter.onSetup.add(onSetup);

    return () => {
      highlighter.onSetup.remove(onSetup);
      cleanup?.();
    };
  }, [components, active]);

  return { members, setMembers, clearSelection };
}
