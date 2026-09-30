/**
 * Main-thread side of the IFC -> fragments conversion worker.
 *
 * Owns one worker per conversion and terminates it when the conversion ends,
 * however it ends. A per-call worker rather than a pooled one because
 * termination is the only reliable way to stop web-ifc mid-geometry: a single
 * geometry call is synchronous inside the WASM module and never yields, so
 * nothing short of killing the thread can interrupt it. A pooled worker would
 * have to be discarded on the first cancel anyway.
 */
import type { ImportRequest, ImportResponse } from "./ifc-import.worker";

/** Progress as the importer reports it, forwarded to the caller. */
export interface ImportProgress {
  /** 0..1. */
  value: number;
  /** "geometries" | "attributes" | "relations" | "conversion". */
  process: string;
  state: string;
  entitiesProcessed?: number;
}

/**
 * How long the importer may go without reporting progress before the
 * conversion is declared stalled and the worker killed.
 *
 * This is the backstop behind the boolean-budget gate, for the pathology the
 * gate does not recognise. It has to clear the longest legitimate gap between
 * two progress ticks, which is not the same as the longest total load: ticks
 * arrive per stage and per entity class, so even a very large file reports
 * something every few seconds. Two minutes is far above anything observed
 * (the 58 MB reference file ticks several times a second) and still turns an
 * unbounded hang into a bounded wait.
 *
 * Deliberately generous: a false stall on a slow-but-working file destroys work
 * the user was waiting for, while a late kill only costs them time they were
 * already losing.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

export interface ConvertOptions {
  /** Mirrors `IfcLoader.settings.wasm` — the vendored, offline WASM location. */
  wasmPath: string;
  wasmAbsolute: boolean;
  onProgress?: (progress: ImportProgress) => void;
  /** Aborts the conversion and terminates the worker. */
  signal?: AbortSignal;
  /** Override the stall backstop; see {@link DEFAULT_STALL_TIMEOUT_MS}. */
  stallTimeoutMs?: number;
}

/** Thrown when the conversion was stopped rather than failing on its own. */
export class ImportCancelledError extends Error {
  constructor(message = "IFC import cancelled") {
    super(message);
    this.name = "ImportCancelledError";
  }
}

/**
 * Thrown when the importer stopped reporting progress — the signature of a
 * geometry call that will not return. Carries the last stage seen, because that
 * is the only clue to WHICH element is at fault once the thread is gone.
 */
export class ImportStalledError extends Error {
  constructor(
    readonly stalledForMs: number,
    readonly lastProgress: ImportProgress | null,
  ) {
    super(
      `IFC import stalled: no progress for ${Math.round(stalledForMs / 1000)} s` +
        (lastProgress ? ` (last stage: ${lastProgress.process})` : " (never started)"),
    );
    this.name = "ImportStalledError";
  }
}

/**
 * Convert IFC bytes to fragments bytes in a worker.
 *
 * `bytes` is TRANSFERRED — pass a copy if the buffer is needed afterwards. The
 * caller keeps the original IFC bytes for the extractors (see `ifc-sources.ts`),
 * so this must never be handed the registry's buffer.
 */
export function convertIfcToFragments(
  bytes: ArrayBuffer,
  {
    wasmPath,
    wasmAbsolute,
    onProgress,
    signal,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  }: ConvertOptions,
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ImportCancelledError());
      return;
    }

    const worker = new Worker(new URL("./ifc-import.worker.ts", import.meta.url), {
      type: "module",
    });

    // Stall backstop. Terminating the worker is the only way out: a web-ifc
    // geometry call is synchronous inside the WASM module, so the thread cannot
    // be asked to stop — it has to be destroyed.
    let lastProgress: ImportProgress | null = null;
    let lastTickAt = Date.now();
    const stallTimer = setInterval(() => {
      const silentFor = Date.now() - lastTickAt;
      if (silentFor >= stallTimeoutMs) {
        finish(() => reject(new ImportStalledError(silentFor, lastProgress)));
      }
    }, Math.max(1000, Math.floor(stallTimeoutMs / 10)));

    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      run();
    };

    function onAbort() {
      finish(() => reject(new ImportCancelledError()));
    }
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<ImportResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        lastTickAt = Date.now();
        lastProgress = message;
        onProgress?.(message);
        return;
      }
      if (message.type === "done") {
        finish(() => resolve(message.bytes));
        return;
      }
      finish(() => reject(new Error(message.message)));
    };

    // A worker that dies outright (OOM, a WASM abort) fires `error` and never
    // `message` — without this the load would hang exactly the way the
    // main-thread version did, just invisibly.
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "IFC import worker failed")));
    };
    worker.onmessageerror = () => {
      finish(() => reject(new Error("IFC import worker sent an unreadable message")));
    };

    const request: ImportRequest = { bytes, wasmPath, wasmAbsolute };
    worker.postMessage(request, [bytes]);
  });
}
