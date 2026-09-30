/**
 * Connection Library persistence.
 *
 * The library is DISK-BACKED when a dev backend is present (see
 * apps/viewer/connection-library-server.mts): one JSON file per IFC under
 * <repo>/.data/connection-library/. localStorage is kept as a mirror, used as
 * the store when there is no backend (a static production bundle) and as a
 * read cache if the request fails. localStorage alone was not enough — it is
 * scoped to the browser profile + origin, is wiped by "clear site data", and
 * its ~5MB quota is reachable because every saved connection carries its full
 * rawRows.
 *
 * Every mutation writes the WHOLE list: the caller always holds the complete
 * library for one IFC, so there is nothing to merge server-side.
 */
import { type MemberVectorRow } from "./types";
import type { CameraViewpoint } from "./camera-viewpoint";

export interface SavedConnection {
  id: string;
  name: string;
  createdAt: number;

  // State required to completely restore the view and extraction result
  rawRows: MemberVectorRow[];
  bearingGlobalId: string | null;
  geomTypeById: [string, "Continuous" | "Ended"][]; // Map serialized as array of entries
  manualFlips: string[]; // Set serialized as array
  memberRefs: [string, { modelId: string; localId: number }][]; // Map serialized as array of entries
  ifcSource: "tekla" | "autodesk";
  /**
   * Camera vantage at save time — clicking the connection returns the camera
   * here. Optional: connections saved before this feature have none, and fall
   * back to framing the members (fit-to-box).
   */
  camera?: CameraViewpoint;
}

const STORAGE_PREFIX = "member-vectors-lib-";
const API_ROUTE = "/api/connection-library";
/** Set once localStorage libraries have been pushed to the backend. Marked in
 *  localStorage (not memory) so the sweep really is once per browser, not once
 *  per page load. */
const MIGRATED_FLAG = "member-vectors-lib-migrated-to-disk";

function getStorageKey(ifcName: string) {
  return `${STORAGE_PREFIX}${ifcName}`;
}

function readLocal(ifcName: string): SavedConnection[] {
  try {
    const data = localStorage.getItem(getStorageKey(ifcName));
    if (!data) return [];
    return JSON.parse(data) as SavedConnection[];
  } catch (err) {
    console.error("Failed to load connections from localStorage", err);
    return [];
  }
}

function writeLocal(ifcName: string, connections: SavedConnection[]): void {
  try {
    localStorage.setItem(getStorageKey(ifcName), JSON.stringify(connections));
  } catch (err) {
    // Quota exceeded is expected once a few connections are saved — the disk
    // backend is the real store, so this is a warning, not a failure.
    console.warn("Failed to mirror connections to localStorage", err);
  }
}

/**
 * Whether the disk backend answered. Probed on the first read and remembered:
 * a static build must not re-attempt a request per mutation, and once the
 * backend has answered we must NOT silently degrade to localStorage on a later
 * transient error (that would look like a successful save that vanishes).
 */
let backendAvailable: boolean | null = null;

async function serverGet(ifcName: string): Promise<SavedConnection[] | null> {
  try {
    const res = await fetch(`${API_ROUTE}?ifc=${encodeURIComponent(ifcName)}`, { cache: "no-store" });
    // A static host answers unknown paths with index.html (200 + text/html) —
    // check the content type, not just res.ok, or JSON.parse would throw and
    // be misread as a backend error.
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return null;
    const body = (await res.json()) as { connections?: SavedConnection[] };
    return Array.isArray(body.connections) ? body.connections : [];
  } catch {
    return null;
  }
}

async function serverPut(ifcName: string, connections: SavedConnection[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_ROUTE}?ifc=${encodeURIComponent(ifcName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One-time sweep: push every library that only exists in this browser's
 * localStorage up to the disk store. Runs before the first read so connections
 * saved by the pre-disk build (including any saved under a stale IFC name) end
 * up as files instead of being stranded.
 */
async function migrateLocalLibraries(): Promise<void> {
  if (localStorage.getItem(MIGRATED_FLAG)) return;
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX) && key !== MIGRATED_FLAG) names.push(key.slice(STORAGE_PREFIX.length));
  }
  for (const name of names) {
    const local = readLocal(name);
    if (local.length === 0) continue;
    // Don't clobber a disk library that already has content.
    const remote = await serverGet(name);
    if (remote === null) return; // backend gone mid-sweep: retry on the next load
    if (remote.length > 0) continue;
    if (!(await serverPut(name, local))) return;
    console.info(`Connection library: migrated ${local.length} connection(s) for "${name}" to disk`);
  }
  localStorage.setItem(MIGRATED_FLAG, "1");
}

/** Load the library for one IFC. Disk when available, else the local mirror. */
export async function loadConnections(ifcName: string): Promise<SavedConnection[]> {
  if (backendAvailable !== false) await migrateLocalLibraries();
  const remote = await serverGet(ifcName);
  if (remote !== null) {
    backendAvailable = true;
    writeLocal(ifcName, remote); // keep the offline mirror current
    return remote;
  }
  if (backendAvailable === true) {
    console.error("Connection library: disk backend stopped answering; showing the local mirror");
  }
  backendAvailable = false;
  return readLocal(ifcName);
}

/** Replace the stored library for one IFC. Returns the list actually stored. */
async function persist(ifcName: string, connections: SavedConnection[]): Promise<SavedConnection[]> {
  writeLocal(ifcName, connections);
  if (backendAvailable !== false) {
    const ok = await serverPut(ifcName, connections);
    backendAvailable = ok;
    if (!ok) console.error("Connection library: could not write to disk; kept in this browser only");
  }
  return connections;
}

export async function saveConnection(ifcName: string, connection: SavedConnection): Promise<SavedConnection[]> {
  const existing = await loadConnections(ifcName);
  return persist(ifcName, [...existing, connection]);
}

export async function removeConnection(ifcName: string, connectionId: string): Promise<SavedConnection[]> {
  const existing = await loadConnections(ifcName);
  return persist(
    ifcName,
    existing.filter((c) => c.id !== connectionId),
  );
}

export async function renameConnection(
  ifcName: string,
  connectionId: string,
  newName: string,
): Promise<SavedConnection[]> {
  const existing = await loadConnections(ifcName);
  return persist(
    ifcName,
    existing.map((c) => (c.id === connectionId ? { ...c, name: newName } : c)),
  );
}
