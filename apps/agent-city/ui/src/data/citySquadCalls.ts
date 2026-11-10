import type { PluginResponseV1 } from "@agent-vitals/app-sdk";
import type { CityProjectionV1 } from "./provider";
import { invokeHost } from "../host";
import { parseSquadEnvelope, type SquadEnvelope } from "../engine/squadEvents";
import { ensureCityAssetObject, type CityAssetBookmarkObjectClient } from "./cityAssetBookmarks";
import type { TypedObjectResultV1 } from "@agent-vitals/app-sdk";
import { readLegacyCityStoreSnapshot } from "./cityLegacyStore";

export const CITY_SQUAD_STATE_KEY = "city-squad:v1";
const MAX_EVENTS = 80;
const MAX_CLAIMS = 200;
const MAX_STATE_BYTES = 40 * 1024;
const MIN_TTL_SEC = 15;
const MAX_TTL_SEC = 900;
const DEFAULT_TTL_SEC = 90;
const squadCrosswalksResolved = new Set<string>();

type Actor = { agent_id: string; agent_name: string };
type Claim = { session_id: string; asset_ref: string; agent_id: string; agent_name: string; expires_at: number; updated_at: number };
type SquadState = { schemaVersion: 1; events: SquadEnvelope[]; claims: Claim[]; legacyClaimsRevision?: string };
type StateResult = { revision: number; value: unknown };
type StateClient = {
  read(): Promise<StateResult>;
  write(revision: number, value: SquadState): Promise<{ revision: number }>;
};

function hostRequest<T>(method: string, payload: object): Promise<T> {
  const requestId = `city-squad-${crypto.randomUUID()}`;
  return invokeHost<PluginResponseV1<T>>("plugin_request", { request: {
    version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method, payload,
  } }).then((response) => {
    if (response.version !== 1 || response.requestId !== requestId || !response.ok || response.result === null) {
      throw new Error(response.error?.code ?? "city_squad_unavailable");
    }
    return response.result;
  });
}

const stateClient: StateClient = {
  read: () => hostRequest("plugin.state.read", { key: CITY_SQUAD_STATE_KEY }),
  write: (revision, value) => hostRequest("plugin.state.write", { key: CITY_SQUAD_STATE_KEY, revision, value }),
};

function validAssetRef(value: unknown): value is string { return typeof value === "string" && /^ca_[0-9a-f]{32}$/.test(value); }
function validSessionRef(value: unknown): value is string { return typeof value === "string" && /^sr_[0-9a-f]{32}$/.test(value); }
function validActor(agentId: unknown, agentName: unknown): Actor {
  if (typeof agentId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(agentId.trim())
      || typeof agentName !== "string" || !agentName.trim() || new TextEncoder().encode(agentName).byteLength > 80
      || /[\u0000-\u001f\u007f]/.test(agentName)) {
    throw new Error("invalid_actor");
  }
  return { agent_id: agentId.trim(), agent_name: agentName.trim() };
}

function emptyState(): SquadState { return { schemaVersion: 1, events: [], claims: [] }; }

function parseState(value: unknown): SquadState {
  if (value === null || value === undefined) return emptyState();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("city_squad_state_invalid");
  const row = value as Record<string, unknown>;
  if ((Object.keys(row).length !== 3 && Object.keys(row).length !== 4) || !Object.hasOwn(row, "schemaVersion") || !Object.hasOwn(row, "events")
      || !Object.hasOwn(row, "claims") || (Object.hasOwn(row, "legacyClaimsRevision")
        && (typeof row.legacyClaimsRevision !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(row.legacyClaimsRevision)))
      || Object.keys(row).some((key) => !["schemaVersion", "events", "claims", "legacyClaimsRevision"].includes(key))
      || row.schemaVersion !== 1 || !Array.isArray(row.events) || row.events.length > MAX_EVENTS
      || !Array.isArray(row.claims) || row.claims.length > MAX_CLAIMS) throw new Error("city_squad_state_invalid");
  const events = row.events.map(parseSquadEnvelope);
  if (events.some((event) => event === null)) throw new Error("city_squad_state_invalid");
  const claims: Claim[] = [];
  for (const raw of row.claims) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("city_squad_state_invalid");
    const claim = raw as Record<string, unknown>;
    const agentName = typeof claim.agent_name === "string" ? claim.agent_name.trim() : "";
    if (!validSessionRef(claim.session_id) || !validAssetRef(claim.asset_ref)
        || typeof claim.agent_id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(claim.agent_id)
        || Object.keys(claim).length !== 6 || !["session_id", "asset_ref", "agent_id", "agent_name", "expires_at", "updated_at"].every((key) => Object.hasOwn(claim, key))
        || typeof claim.agent_name !== "string" || !agentName || new TextEncoder().encode(agentName).byteLength > 80
        || /[\u0000-\u001f\u007f]/.test(agentName)
        || !Number.isSafeInteger(claim.expires_at) || !Number.isSafeInteger(claim.updated_at)) throw new Error("city_squad_state_invalid");
    claims.push({ ...claim, agent_name: agentName } as unknown as Claim);
  }
  if (new Set(claims.map((claim) => claim.asset_ref)).size !== claims.length) throw new Error("city_squad_state_invalid");
  return { schemaVersion: 1, events: events as SquadEnvelope[], claims,
    ...(typeof row.legacyClaimsRevision === "string" ? { legacyClaimsRevision: row.legacyClaimsRevision } : {}) };
}

function newEnvelope(sessionId: string, actor: Actor, kind: SquadEnvelope["kind"], payload: Record<string, unknown>, now: number): SquadEnvelope {
  return { v: 1, id: `evt_${crypto.randomUUID()}`, ts: now, session_id: sessionId,
    agent_id: actor.agent_id, agent_name: actor.agent_name, kind, payload };
}

function resolveSession(projection: CityProjectionV1 | null, sessionId: unknown): { id: string; assetRef: string } {
  if (typeof sessionId !== "string" || !projection || projection.source !== "local") throw new Error("session_unavailable");
  const row = projection.sessions.find((session) => session.id === sessionId || session.asset_ref === sessionId);
  if (!row || !validSessionRef(row.id) || !validAssetRef(row.asset_ref)) throw new Error("session_unavailable");
  return { id: row.id, assetRef: row.asset_ref };
}

function validationError(rule: string, message: string, suggestedFix: string) {
  return { ok: false, error: { kind: "validation", rule, message, suggested_fix: suggestedFix }, envelope: null };
}

function compactText(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_chat");
  const text = value.trim();
  if (!text || new TextEncoder().encode(text).byteLength > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("invalid_chat");
  return text;
}

function emit(sessionId: string, actor: Actor, kind: SquadEnvelope["kind"], payload: Record<string, unknown>, now: number) {
  return newEnvelope(sessionId, actor, kind, payload, now);
}

/** City-local business adapter. Rust only transports the bounded opaque call. */
export function createCitySquadCallHandlers(input: {
  projection: () => CityProjectionV1 | null;
  onEnvelope: (envelope: SquadEnvelope) => void;
}) {
  let serialized: Promise<unknown> = Promise.resolve();

  async function update(mutator: (current: SquadState, revision: number) => { next: SquadState; result: unknown }): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentResult = await stateClient.read();
      if (!Number.isSafeInteger(currentResult.revision) || currentResult.revision < 0) throw new Error("city_squad_state_invalid");
      const current = parseState(currentResult.value);
      const changed = mutator(current, currentResult.revision);
      const bytes = new TextEncoder().encode(JSON.stringify(changed.next)).byteLength;
      if (bytes > MAX_STATE_BYTES) throw new Error("city_squad_state_full");
      try {
        const written = await stateClient.write(currentResult.revision, changed.next);
        if (written.revision !== currentResult.revision + 1) throw new Error("city_squad_state_invalid");
        return changed.result;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
      }
    }
    throw new Error("city_squad_conflict");
  }

  async function publish(payload: Record<string, unknown>) {
    if (Object.keys(payload).some((key) => !["session_id", "agent_id", "agent_name", "kind", "payload"].includes(key))) throw new Error("invalid_payload");
    const session = resolveSession(input.projection(), payload.session_id);
    const actor = validActor(payload.agent_id, payload.agent_name);
    const kind = payload.kind;
    if (kind !== "chat" && kind !== "claim" && kind !== "release") throw new Error("kind_forbidden");
    const data = payload.payload;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_payload");
    const now = Math.floor(Date.now() / 1000);
    const dispatch: SquadEnvelope[] = [];
    const result = await update((current) => {
      const priorClaims = current.claims;
      const claims = priorClaims.filter((claim) => claim.expires_at > now);
      const events = current.events.slice();
      const emitAndStore = (who: Actor, eventKind: SquadEnvelope["kind"], body: Record<string, unknown>) => {
        const event = emit(session.id, who, eventKind, body, now);
        dispatch.push(event); events.unshift(event); events.length = Math.min(events.length, MAX_EVENTS);
        return event;
      };
      if (kind === "chat") {
        if (Object.keys(data as Record<string, unknown>).some((key) => key !== "text")) throw new Error("invalid_payload");
        const text = compactText((data as Record<string, unknown>).text);
        return { next: { schemaVersion: 1, events, claims, ...(current.legacyClaimsRevision ? { legacyClaimsRevision: current.legacyClaimsRevision } : {}) }, result: {
          ok: true, error: null, envelope: emitAndStore(actor, "chat", { text }),
          notify: { channel: "host-socket", ui: "pushed" },
        } };
      }
      const dataRow = data as Record<string, unknown>;
      if (Object.keys(dataRow).some((key) => kind === "claim" ? !["asset_ref", "ttl_sec"].includes(key) : !["asset_ref", "reason"].includes(key))) throw new Error("invalid_payload");
      const assetRef = dataRow.asset_ref;
      if (!validAssetRef(assetRef) || assetRef !== session.assetRef) throw new Error("asset_mismatch");
      const previous = priorClaims.find((claim) => claim.asset_ref === assetRef);
      if (kind === "claim") {
        const ttl = dataRow.ttl_sec === undefined ? DEFAULT_TTL_SEC : dataRow.ttl_sec;
        if (!Number.isSafeInteger(ttl) || Number(ttl) < MIN_TTL_SEC || Number(ttl) > MAX_TTL_SEC) throw new Error("invalid_ttl");
        if (previous && previous.agent_id !== actor.agent_id) {
          const former: Actor = { agent_id: previous.agent_id, agent_name: previous.agent_name };
          emitAndStore(former, "release", { asset_ref: assetRef, reason: previous.expires_at <= now ? "ttl" : "stolen", stolen_by: actor.agent_id });
        } else if (previous && previous.expires_at <= now) {
          emitAndStore(actor, "release", { asset_ref: assetRef, reason: "ttl" });
        }
        const expiresAt = now + Number(ttl);
        const claim: Claim = { session_id: session.id, asset_ref: assetRef, ...actor, expires_at: expiresAt, updated_at: now };
        const nextClaims = [...claims.filter((entry) => entry.asset_ref !== assetRef), claim];
        const envelope = emitAndStore(actor, "claim", { asset_ref: assetRef, ttl_sec: ttl, expires_at: expiresAt });
        return { next: { schemaVersion: 1, events, claims: nextClaims, ...(current.legacyClaimsRevision ? { legacyClaimsRevision: current.legacyClaimsRevision } : {}) }, result: {
          ok: true, error: null, envelope, ...(previous && previous.agent_id !== actor.agent_id ? {
            replaced: events.find((event) => event.kind === "release" && event.payload.stolen_by === actor.agent_id) ?? null,
          } : {}), notify: { channel: "host-socket", ui: "pushed" },
        } };
      }
      if (dataRow.reason !== undefined && dataRow.reason !== "manual") throw new Error("invalid_release");
      if (!previous) return { next: { schemaVersion: 1, events, claims, ...(current.legacyClaimsRevision ? { legacyClaimsRevision: current.legacyClaimsRevision } : {}) }, result: validationError("no_claim", "no active claim on this lot", "claim the lot first, or wait for an existing claim to expire") };
      if (previous.agent_id !== actor.agent_id && previous.expires_at > now) {
        return { next: { schemaVersion: 1, events, claims, ...(current.legacyClaimsRevision ? { legacyClaimsRevision: current.legacyClaimsRevision } : {}) }, result: { ok: false, error: {
          kind: "conflict", rule: "not_holder", message: "another agent holds this claim; steal it with claim or wait for TTL",
          suggested_fix: "publish kind=claim on the same asset_ref to steal",
        }, envelope: null } };
      }
      const reason = previous.expires_at <= now ? "ttl" : "manual";
      const envelope = emitAndStore(actor, "release", { asset_ref: assetRef, reason });
      return { next: { schemaVersion: 1, events, claims: claims.filter((entry) => entry.asset_ref !== assetRef), ...(current.legacyClaimsRevision ? { legacyClaimsRevision: current.legacyClaimsRevision } : {}) }, result: {
        ok: true, error: null, envelope, notify: { channel: "host-socket", ui: "pushed" },
      } };
    });
    for (const envelope of dispatch) input.onEnvelope(envelope);
    return result;
  }

  return {
    "city.im.publish": (payload: Record<string, unknown>) => {
      const result = serialized.then(() => publish(payload));
      serialized = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export async function readCitySquadSnapshot(): Promise<{ events: SquadEnvelope[]; claims: Claim[] }> {
  const response = await stateClient.read();
  if (!Number.isSafeInteger(response.revision) || response.revision < 0) throw new Error("city_squad_state_invalid");
  const state = parseState(response.value);
  const now = Math.floor(Date.now() / 1000);
  return { events: state.events.slice().reverse(), claims: state.claims.filter((claim) => claim.expires_at > now) };
}

/** One-time bridge for claim/mailbox rows written by the retired Rust City IM store. */
export async function importLegacyCitySquadSnapshot(legacyClaims: unknown, legacyMailbox: unknown, legacyClaimsRevision?: string): Promise<boolean> {
  if (legacyClaimsRevision !== undefined && !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(legacyClaimsRevision)) throw new Error("city_legacy_revision_invalid");
  const now = Math.floor(Date.now() / 1000);
  const imported: SquadEnvelope[] = [];
  const mailbox = parseSquadEnvelope(legacyMailbox);
  if (mailbox) imported.push(mailbox);
  if (Array.isArray(legacyClaims)) {
    for (const raw of legacyClaims.slice(0, MAX_CLAIMS)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const agent = (() => {
        try { return validActor(row.agent_id, row.agent_name); } catch { return null; }
      })();
      if (!agent || !validSessionRef(row.session_id) || !validAssetRef(row.asset_ref)
          || !Number.isSafeInteger(row.expires_at) || Number(row.expires_at) <= now
          || !Number.isSafeInteger(row.updated_at) || Number(row.updated_at) < 0) continue;
      imported.push({ v: 1, id: `evt_migrated_claim_${row.asset_ref}_${row.updated_at}_${row.expires_at}`.slice(0, 80),
        ts: Number(row.updated_at), session_id: row.session_id, agent_id: agent.agent_id, agent_name: agent.agent_name,
        kind: "claim", payload: { asset_ref: row.asset_ref, expires_at: Number(row.expires_at) } });
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await stateClient.read();
    if (!Number.isSafeInteger(current.revision) || current.revision < 0) throw new Error("city_squad_state_invalid");
    const state = parseState(current.value);
    if (legacyClaimsRevision && state.legacyClaimsRevision === legacyClaimsRevision) return true;
    const events = [...state.events];
    const claims = [...state.claims];
    let changed = legacyClaimsRevision !== undefined && state.legacyClaimsRevision !== legacyClaimsRevision;
    for (const event of imported) {
      if (events.some((existing) => existing.id === event.id)) continue;
      events.unshift(event);
      changed = true;
      const assetRef = event.payload.asset_ref;
      const expiresAt = event.payload.expires_at;
      if (!validAssetRef(assetRef)) continue;
      if (event.kind === "release" || event.kind === "set" || event.kind === "reset") {
        const remaining = claims.filter((claim) => claim.asset_ref !== assetRef);
        if (remaining.length !== claims.length) changed = true;
        claims.splice(0, claims.length, ...remaining);
        continue;
      }
      if (event.kind !== "claim" || !Number.isSafeInteger(expiresAt) || Number(expiresAt) <= now) continue;
      const existing = claims.find((claim) => claim.asset_ref === assetRef);
      if (!existing || existing.updated_at < event.ts
          || (existing.updated_at === event.ts && existing.expires_at < Number(expiresAt))) {
        const replacement: Claim = { session_id: event.session_id, asset_ref: assetRef, agent_id: event.agent_id,
          agent_name: event.agent_name, expires_at: Number(expiresAt), updated_at: event.ts };
        const index = claims.findIndex((claim) => claim.asset_ref === assetRef);
        if (index >= 0) claims[index] = replacement;
        else claims.push(replacement);
        changed = true;
      }
    }
    if (!changed) return true;
    const next: SquadState = { schemaVersion: 1, events: events.slice(0, MAX_EVENTS), claims: claims.slice(0, MAX_CLAIMS),
      ...(legacyClaimsRevision ? { legacyClaimsRevision } : state.legacyClaimsRevision ? { legacyClaimsRevision: state.legacyClaimsRevision } : {}) };
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_STATE_BYTES) throw new Error("city_squad_state_full");
    try {
      const written = await stateClient.write(current.revision, next);
      if (written.revision !== current.revision + 1) throw new Error("city_squad_state_invalid");
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "revision_conflict" || attempt === 2) throw error;
    }
  }
  throw new Error("city_squad_conflict");
}

let legacyClaimsImport: Promise<boolean> | null = null;

/** Import legacy SQLite claim rows through the bounded typed export, once per source revision. */
export function importLegacyCityClaimsFromTypedStore(): Promise<boolean> {
  if (legacyClaimsImport) return legacyClaimsImport;
  legacyClaimsImport = (async () => {
    const existing = parseState((await stateClient.read()).value);
    if (existing.legacyClaimsRevision) return true;
    if (!window.__AV_PLUGIN_INSTANCE__) return false;
    const snapshot = await readLegacyCityStoreSnapshot();
    return importLegacyCitySquadSnapshot(snapshot.claims, snapshot.squadMailbox, snapshot.sourceRevision);
  })().catch((error) => {
    legacyClaimsImport = null;
    throw error;
  });
  return legacyClaimsImport;
}

/** Persist old claim ca_* identities against their typed session source refs. */
export async function ensureCitySquadAssetCrosswalks(
  projection: CityProjectionV1,
  stableRefByAssetRef: ReadonlyMap<string, string>,
): Promise<void> {
  if (projection.source !== "local" || !projection.sessions.length || !stableRefByAssetRef.size) return;
  const stableRefBySessionId = new Map<string, string>();
  for (const session of projection.sessions) {
    const stableRef = typeof session.asset_ref === "string" ? stableRefByAssetRef.get(session.asset_ref) : undefined;
    if (stableRef && validSessionRef(session.id)) stableRefBySessionId.set(session.id, stableRef);
  }
  if (!stableRefBySessionId.size) return;
  const snapshot = await readCitySquadSnapshot();
  const rows = snapshot.claims.flatMap((claim) => {
    const stableRef = stableRefBySessionId.get(claim.session_id);
    if (!stableRef || !validAssetRef(claim.asset_ref)) return [];
    const key = `${claim.asset_ref}\0${stableRef}`;
    return squadCrosswalksResolved.has(key) ? [] : [{ assetRef: claim.asset_ref, stableRef, key }];
  });
  if (!rows.length) return;
  const instanceId = window.__AV_PLUGIN_INSTANCE__;
  if (!instanceId) return;
  const [{ createTypedObjectClient }] = await Promise.all([import("@agent-vitals/app-sdk")]);
  const objects = createTypedObjectClient(instanceId, (request) =>
    invokeHost<PluginResponseV1<TypedObjectResultV1>>("plugin_request", { request })) as CityAssetBookmarkObjectClient;
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(rows.slice(offset, offset + 8).map(async ({ assetRef, stableRef, key }) => {
      try {
        await ensureCityAssetObject(objects, assetRef, stableRef);
        if (squadCrosswalksResolved.size >= 2_000) squadCrosswalksResolved.clear();
        squadCrosswalksResolved.add(key);
      } catch { /* Keep the existing claim active; retry the identity migration next refresh. */ }
    }));
  }
}


