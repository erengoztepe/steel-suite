/**
 * Floating identifier labels over the currently-selected viewer elements.
 *
 * Toggled by the control-panel's "Labels" button, which also picks WHICH
 * identifier to show — Tag or GUID — independent of the Tekla/Autodesk
 * export-source setting. While enabled, every element in the Highlighter's
 * "select" selection gets a small HTML label anchored to its bounding-box
 * center via `@thatopen/components-front`'s `Marker` (CSS2DObject-based — no
 * manual screen-projection math needed). Labels are created with
 * `isStatic: true` so they are never merged into cluster labels, even when
 * several selected members sit close together at a joint.
 *
 * Each label reads "(N) identifier" where N is the member's 1-based position
 * in *selection order* — the same order-diffing scheme member-vectors-panel's
 * `useMemberSelection` uses on the same Highlighter events, so a member shows
 * the same index here as it does in the joint table and the right-side
 * selection list.
 *
 * Live-updates as the selection changes (add/remove/reorder markers to
 * match), and clears everything when disabled, the identifier choice flips, or
 * unmounted.
 */

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { Components, FragmentsManager, OrthoPerspectiveCamera, SimpleScene, SimpleWorld } from "@thatopen/components";
import { Highlighter, Marker, type PostproductionRenderer } from "@thatopen/components-front";
import * as THREE from "three";

type World = SimpleWorld<SimpleScene, OrthoPerspectiveCamera, PostproductionRenderer>;

interface MemberIdentity {
  globalId: string;
  tag: string;
}

function extractValue(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw === "object" && "value" in raw) {
    return extractValue((raw as Record<string, unknown>).value);
  }
  return "";
}

function makeLabelElement(text: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.pointerEvents = "none";
  el.style.background = "rgba(15, 23, 42, 0.85)";
  el.style.color = "#e2e8f0";
  el.style.font = "500 11px/1.4 system-ui, sans-serif";
  el.style.padding = "2px 6px";
  el.style.borderRadius = "4px";
  el.style.border = "1px solid rgba(148, 163, 184, 0.5)";
  el.style.whiteSpace = "nowrap";
  el.style.transform = "translate(-50%, -140%)"; // sit just above the anchor point
  return el;
}

function memberKey(modelId: string, localId: number): string {
  return `${modelId}:${localId}`;
}

export function useTagLabels(
  components: Components,
  worldRef: MutableRefObject<World | null> | undefined,
  enabled: boolean,
  /** Which identifier the floating label shows — chosen directly via the "Labels" control, independent of the Tekla/Autodesk export-source setting. */
  identifier: "tag" | "guid" = "tag",
) {
  const markerIdsRef = useRef<Map<string, string>>(new Map());
  const orderRef = useRef<string[]>([]);
  const indexRef = useRef<Map<string, number>>(new Map());
  const identityCacheRef = useRef<Map<string, MemberIdentity>>(new Map());
  const boxCacheRef = useRef<Map<string, THREE.Vector3>>(new Map());

  useEffect(() => {
    const world = worldRef?.current;
    if (!world) return;

    const marker = components.get(Marker);
    const highlighter = components.get(Highlighter);
    const fragmentsManager = components.get(FragmentsManager);

    const clearAll = () => {
      for (const id of markerIdsRef.current.values()) marker.delete(id);
      markerIdsRef.current.clear();
      orderRef.current = [];
      indexRef.current.clear();
    };

    if (!enabled) {
      clearAll();
      return;
    }

    let cancelled = false;

    const createMarker = (key: string, index: number) => {
      const identity = identityCacheRef.current.get(key);
      const center = boxCacheRef.current.get(key);
      if (!identity || !center) return;
      const value =
        identifier === "guid"
          ? identity.globalId || identity.tag || "—"
          : identity.tag || identity.globalId || "—";
      const label = `(${index + 1}) ${value}`;
      const id = marker.create(world, makeLabelElement(label), center, true);
      if (id) markerIdsRef.current.set(key, id);
      indexRef.current.set(key, index);
    };

    const sync = async (modelIdMap: Record<string, Set<number>>) => {
      const wantedKeys = new Set<string>();
      const encounterOrder: string[] = [];
      for (const [modelId, ids] of Object.entries(modelIdMap)) {
        for (const id of ids) {
          const key = memberKey(modelId, id);
          wantedKeys.add(key);
          encounterOrder.push(key);
        }
      }

      // Drop markers for elements no longer selected.
      for (const [key, markerId] of markerIdsRef.current) {
        if (!wantedKeys.has(key)) {
          marker.delete(markerId);
          markerIdsRef.current.delete(key);
          indexRef.current.delete(key);
        }
      }

      // Diff against the previous order (JS Sets don't give a reliable
      // cross-model order) so members keep a stable index as long as they
      // stay selected — mirrors useMemberSelection's ordering scheme.
      const kept = orderRef.current.filter((k) => wantedKeys.has(k));
      const keptSet = new Set(kept);
      const added: string[] = [];
      for (const key of encounterOrder) {
        if (keptSet.has(key) || added.includes(key)) continue;
        added.push(key);
      }
      const newOrder = [...kept, ...added];
      orderRef.current = newOrder;

      // Resolve identity/box for newly-selected elements not yet cached.
      const toResolveByModel: Record<string, number[]> = {};
      for (const key of added) {
        const [modelId, localIdStr] = key.split(":");
        (toResolveByModel[modelId] ??= []).push(Number(localIdStr));
      }
      for (const [modelId, localIds] of Object.entries(toResolveByModel)) {
        const model = fragmentsManager.list.get(modelId);
        if (!model) continue;
        const [itemsMap, dataArr, boxes] = await Promise.all([
          model.getItems(localIds).catch(() => undefined),
          model.getItemsData(localIds, { attributesDefault: true }).catch(() => null),
          model.getBoxes(localIds).catch(() => null),
        ]);
        if (cancelled) return;
        localIds.forEach((localId, i) => {
          const key = memberKey(modelId, localId);
          const box = boxes?.[i];
          if (!box) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry = itemsMap?.get(localId) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = dataArr?.[i] as any;
          identityCacheRef.current.set(key, {
            globalId: entry?.guid || extractValue(data?._guid) || extractValue(data?.GlobalId),
            tag: extractValue(data?.Tag),
          });
          boxCacheRef.current.set(key, box.getCenter(new THREE.Vector3()));
        });
      }
      if (cancelled) return;

      // (Re)create any marker that's new or whose index shifted — the label
      // text embeds the index, so a shifted member needs a fresh label.
      newOrder.forEach((key, index) => {
        if (markerIdsRef.current.has(key) && indexRef.current.get(key) === index) return;
        const existingMarkerId = markerIdsRef.current.get(key);
        if (existingMarkerId) {
          marker.delete(existingMarkerId);
          markerIdsRef.current.delete(key);
        }
        createMarker(key, index);
      });
    };

    const onHighlight = (modelIdMap: Record<string, Set<number>>) => void sync(modelIdMap);
    const onClear = () => clearAll();

    const subscribe = (): (() => void) => {
      const selectEvents = highlighter.events?.select;
      if (!selectEvents) return () => undefined;
      selectEvents.onHighlight.add(onHighlight);
      selectEvents.onClear.add(onClear);
      // Seed from whatever is already selected when the toggle turns on.
      const selectName = highlighter.config?.selectName ?? "select";
      const current = highlighter.selection?.[selectName];
      if (current && Object.keys(current).length > 0) void sync(current);
      return () => {
        selectEvents.onHighlight.remove(onHighlight);
        selectEvents.onClear.remove(onClear);
      };
    };

    let cleanupSubscription = () => undefined as void;
    if (highlighter.isSetup) cleanupSubscription = subscribe();
    const onSetup = () => {
      cleanupSubscription = subscribe();
    };
    highlighter.onSetup.add(onSetup);

    return () => {
      cancelled = true;
      highlighter.onSetup.remove(onSetup);
      cleanupSubscription();
      clearAll();
    };
  }, [components, worldRef, enabled, identifier]);
}
