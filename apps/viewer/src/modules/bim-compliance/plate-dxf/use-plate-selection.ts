/**
 * Tracks the viewer's current selection, surfacing it only when exactly one
 * IfcPlate is selected (DXF export is a single-part operation). Independent
 * of `useMemberSelection` — that hook filters plates OUT (it only resolves
 * beam/column/member for joint-vector extraction) — but both listen to the
 * same Highlighter "select" events, so a plate click highlights in the
 * viewer either way; this hook just also resolves it here.
 */

import { useEffect, useState } from "react";
import { Components, FragmentsManager } from "@thatopen/components";
import { Highlighter } from "@thatopen/components-front";

import { extractValue } from "../member-vectors/use-member-selection";

export interface SelectedPlate {
  modelId: string;
  localId: number;
  globalId: string;
  name: string;
}

async function resolveSinglePlate(
  components: Components,
  modelIdMap: Record<string, Set<number>>,
): Promise<SelectedPlate | null> {
  const entries = Object.entries(modelIdMap).flatMap(([modelId, ids]) =>
    Array.from(ids).map((localId) => ({ modelId, localId })),
  );
  if (entries.length !== 1) return null;
  const { modelId, localId } = entries[0];

  const fragmentsManager = components.get(FragmentsManager);
  const model = fragmentsManager.list.get(modelId);
  if (!model) return null;

  let entry: any;
  let data: any;
  try {
    entry = (await model.getItems([localId])).get(localId);
  } catch {
    entry = undefined;
  }
  try {
    data = (await model.getItemsData([localId], { attributesDefault: true }))[0];
  } catch {
    data = undefined;
  }

  const ifcClass = entry?.category || extractValue(data?._category) || "";
  if (!/plate/i.test(ifcClass)) return null;

  return {
    modelId,
    localId,
    globalId: entry?.guid || extractValue(data?._guid) || extractValue(data?.GlobalId),
    name: entry?.data?.Name ? extractValue(entry.data.Name.value) : extractValue(data?.Name),
  };
}

export function usePlateSelection(components: Components, active: boolean): SelectedPlate | null {
  const [plate, setPlate] = useState<SelectedPlate | null>(null);

  useEffect(() => {
    if (!active) return;
    const highlighter = components.get(Highlighter);
    let cleanup: (() => void) | null = null;
    let callId = 0;

    const onHighlight = (modelIdMap: Record<string, Set<number>>) => {
      const thisCall = ++callId;
      resolveSinglePlate(components, modelIdMap).then((resolved) => {
        if (thisCall !== callId) return; // superseded by a newer selection
        setPlate(resolved);
      });
    };
    const onClear = () => setPlate(null);

    const subscribe = () => {
      const selectEvents = highlighter.events?.select;
      if (!selectEvents) return;
      selectEvents.onHighlight.add(onHighlight);
      selectEvents.onClear.add(onClear);
      cleanup = () => {
        selectEvents.onHighlight.remove(onHighlight);
        selectEvents.onClear.remove(onClear);
      };
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

  return plate;
}
