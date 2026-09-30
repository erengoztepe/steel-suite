/**
 * Persists the raw bytes + file name of every IFC currently loaded in the
 * viewer, so the next launch restores the whole set instead of falling back to
 * the bundled default model. IFC files here run tens of MB — well past
 * localStorage's ~5-10MB per-origin quota (and its string-only storage, which
 * would force a ~33% base64 size penalty) — so IndexedDB is the only viable
 * client-side store for the raw ArrayBuffers.
 *
 * A SET rather than one record because a structure split across several files is
 * imported into one viewer (see `ifc-sources.ts`): restoring only the first file
 * would silently drop the imported parts, and with them every joint that spans
 * a seam. Order is preserved — the first record is the base file, the one the
 * others were coordinated against and the one keying the Connection Library.
 */

const DB_NAME = "member-vectors-standalone";
const DB_VERSION = 1;
const STORE_NAME = "last-ifc";
/** The pre-import single-record key, still read once to migrate it forward. */
const LEGACY_RECORD_KEY = "current";
const SESSION_KEY = "session";

export interface IfcRecord {
  name: string;
  buffer: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function get<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(tx.error);
  });
}

/** Save the full set of loaded IFCs, base file first. Replaces any previous set. */
export async function saveIfcSession(records: IfcRecord[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(records, SESSION_KEY);
      // The legacy single record would otherwise shadow an emptied session and
      // resurrect a file the user has since replaced.
      store.delete(LEGACY_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Load the set of IFCs open at the end of the last session, base file first.
 * Empty when nothing was ever saved. A session written by the pre-import build
 * (one record under the legacy key) is read back as a single-file set.
 */
export async function loadIfcSession(): Promise<IfcRecord[]> {
  const db = await openDb();
  try {
    const session = await get<IfcRecord[]>(db, SESSION_KEY);
    if (Array.isArray(session)) return session.filter((r) => r?.buffer && r?.name);
    const legacy = await get<IfcRecord>(db, LEGACY_RECORD_KEY);
    return legacy?.buffer && legacy?.name ? [legacy] : [];
  } finally {
    db.close();
  }
}
