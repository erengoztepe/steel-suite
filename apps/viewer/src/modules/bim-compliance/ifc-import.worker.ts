/**
 * Converts IFC bytes into fragments bytes, off the main thread.
 *
 * WHY. `IfcLoader.load()` runs `IfcImporter.process()` wherever it is called,
 * and the viewer called it on the UI thread. A conversion that takes 36 s does
 * not read as "slow" there — it reads as a crash: no paint, no progress, no
 * cancel, and the `try/catch` around the call never fires because nothing
 * throws. Moving the same work here is what turns an unresponsive tab into a
 * load the user can watch and abandon.
 *
 * This worker deliberately does only the CONVERSION. Handing the resulting
 * fragments bytes to `FragmentsManager` stays on the main thread, because that
 * is where the scene lives — the same split `IfcLoader.load` makes internally.
 */
import { IfcImporter } from "@thatopen/fragments";

export interface ImportRequest {
  /** Raw IFC bytes. Transferred, so the caller must send a copy it can lose. */
  bytes: ArrayBuffer;
  /** Where the vendored web-ifc WASM lives, mirroring `IfcLoader.settings.wasm`. */
  wasmPath: string;
  wasmAbsolute: boolean;
}

export type ImportResponse =
  | {
      type: "progress";
      /** 0..1 as reported by the importer. */
      value: number;
      process: string;
      state: string;
      entitiesProcessed?: number;
    }
  | { type: "done"; bytes: ArrayBuffer }
  | { type: "error"; message: string };

const post = (message: ImportResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(message, transfer ?? []);

self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  const { bytes, wasmPath, wasmAbsolute } = event.data;
  try {
    const importer = new IfcImporter();
    importer.wasm.path = wasmPath;
    importer.wasm.absolute = wasmAbsolute;

    const fragmentBytes = await importer.process({
      bytes: new Uint8Array(bytes),
      // Every tick is also the watchdog's heartbeat — silence here is what the
      // caller reads as "stalled", so this must stay wired up.
      progressCallback: (value, data) =>
        post({
          type: "progress",
          value,
          process: data.process,
          state: data.state,
          entitiesProcessed: data.entitiesProcessed,
        }),
    });

    const out = fragmentBytes.buffer.slice(
      fragmentBytes.byteOffset,
      fragmentBytes.byteOffset + fragmentBytes.byteLength,
    ) as ArrayBuffer;
    post({ type: "done", bytes: out }, [out]);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
