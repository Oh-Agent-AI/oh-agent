/** Minimal same-tab write-ahead guard. No credentials, commands, or battle data. */
export type PendingMarker = {
  version: 1;
  kind: "deployment" | "plan" | "concede";
  matchId: string;
  playerId: string;
  commandId: string;
  baseRevision: number;
};

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ReadResult = { status: "empty" } | { status: "pending"; marker: PendingMarker } | { status: "error" };
type Identity = { matchId: string; playerId: string; capability: string; room: string; invite: string; device: string };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(v);
const safePart = (v: string) => v.length <= 160 && /^[A-Za-z0-9:_-]*$/.test(v);
const validIdentity = (identity: Identity) => id(identity.matchId) && id(identity.playerId)
  && ["mecha:v1", "mecha:v2", "mecha:v3"].includes(identity.capability)
  && safePart(identity.room) && safePart(identity.invite) && safePart(identity.device);

function markerFrom(value: unknown, identity: Identity): PendingMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ["version", "kind", "matchId", "playerId", "commandId", "baseRevision"];
  if (Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)) || v.version !== 1
    || (v.kind !== "deployment" && v.kind !== "plan" && v.kind !== "concede")
    || v.matchId !== identity.matchId || v.playerId !== identity.playerId || !id(v.commandId)
    || typeof v.baseRevision !== "number" || !Number.isSafeInteger(v.baseRevision) || v.baseRevision < 0) return null;
  return v as PendingMarker;
}

export function pendingJournal(storage: StoragePort | null, identity: Identity) {
  const key = `mecha-pending:v1:${JSON.stringify([identity.capability, identity.matchId, identity.playerId, identity.room, identity.invite, identity.device])}`;
  const read = (): ReadResult => {
    if (!storage || !validIdentity(identity)) return { status: "error" };
    try {
      const raw = storage.getItem(key);
      if (raw === null) return { status: "empty" };
      if (raw.length > 1024) return { status: "error" };
      const marker = markerFrom(JSON.parse(raw), identity);
      return marker ? { status: "pending", marker } : { status: "error" };
    } catch { return { status: "error" }; }
  };
  const begin = (marker: PendingMarker): boolean => {
    if (!storage || !validIdentity(identity) || !markerFrom(marker, identity) || read().status !== "empty") return false;
    try {
      const raw = JSON.stringify(marker);
      storage.setItem(key, raw);
      return storage.getItem(key) === raw;
    } catch { return false; }
  };
  const clear = (marker: PendingMarker): boolean => {
    if (!storage) return false;
    try {
      const current = read();
      if (current.status !== "pending" || JSON.stringify(current.marker) !== JSON.stringify(marker)) return false;
      storage.removeItem(key);
      return storage.getItem(key) === null;
    } catch { return false; }
  };
  return { read, begin, clear };
}
