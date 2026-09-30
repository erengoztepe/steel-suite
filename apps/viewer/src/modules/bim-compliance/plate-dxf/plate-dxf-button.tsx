/**
 * Floating "Export DXF" affordance: appears near the top of the viewer only
 * while exactly one IfcPlate is selected. Mirrors member-vectors-panel's
 * download pattern (extract via a fresh web-ifc model opened on the already-
 * held IFC buffer → Blob → synthetic `<a download>` click), but stays
 * independent of the Member Vectors panel/workflow since plates aren't
 * members.
 */

import { useCallback, useState } from "react";
import type { Components } from "@thatopen/components";

import { Button } from "@/components/button";
import { sourceFor, type GetIfcSources } from "../ifc-sources";

import { extractPlateOutlineFromBytes } from "./extract-plate-outline";
import { emitPlateDxf } from "./emit-dxf";
import { usePlateSelection } from "./use-plate-selection";

interface PlateDxfButtonProps {
  components: Components;
  active: boolean;
  getIfcSources: GetIfcSources;
}

export default function PlateDxfButton({ components, active, getIfcSources }: PlateDxfButtonProps) {
  const plate = usePlateSelection(components, active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onExport = useCallback(async () => {
    if (!plate) return;
    // The plate's OWN file — with several IFCs imported together, the outline
    // has to be read from the bytes this plate actually came from; any other
    // file simply doesn't contain its GlobalId.
    const source = sourceFor(getIfcSources(), plate.modelId);
    if (!source) {
      setError("Load an IFC first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outline = await extractPlateOutlineFromBytes(new Uint8Array(source.buffer), plate.globalId);
      if (!outline) {
        setError("Could not extract a section — this element may not be a flat plate.");
        return;
      }
      const dxf = emitPlateDxf(outline);
      const blob = new Blob([dxf], { type: "application/dxf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(plate.name || plate.globalId).replace(/[\\/:*?"<>|]/g, "_")}.dxf`;
      a.click();
      URL.revokeObjectURL(url);
      setError(outline.warning ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [plate, getIfcSources]);

  if (!plate) return null;

  return (
    <div className="absolute top-14 left-4 z-20 flex max-w-sm items-center gap-2 rounded-lg border border-border-primary bg-bg-primary/90 px-3 py-2 shadow backdrop-blur">
      <span className="truncate text-xs text-text-secondary" title={plate.name || plate.globalId}>
        {plate.name || plate.globalId}
      </span>
      <Button
        variant="secondary"
        className="!px-2 !py-1 whitespace-nowrap border border-border-primary text-xs"
        loading={busy}
        onClick={onExport}
      >
        Export DXF
      </Button>
      {error && <span className="truncate text-xs text-red-400">{error}</span>}
    </div>
  );
}
