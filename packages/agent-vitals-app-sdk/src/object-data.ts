import type { PluginRequestV1, PluginResponseV1 } from "./plugin-rpc.js";

const METHOD = "typed-object.request";
const SCHEMA = "plugin-object:v1";
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENTS_PER_COMMIT = 64;
const MAX_PAGE_SIZE = 500;
const TOKEN = /^[a-z0-9._:-]{1,128}$/;
const HANDLE = /^ob_[a-f0-9]{32}$/;
const SCOPE_HANDLE = /^sc_[a-f0-9]{32}$/;
const EVENT_ID = /^ev_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const ALIAS = /^[A-Za-z0-9._:-]{1,128}$/;

export type TypedObjectBodyV1 = Record<string, unknown>;
export type TypedObjectV1 = {
  handle: string;
  alias?: string;
  schemaVersion: number;
  revision: number;
  body: TypedObjectBodyV1;
  deleted: boolean;
};
export type TypedObjectCommitV1 = { revision: number; eventIds: string[] };
export type TypedObjectEventV1 = {
  eventId: string;
  revision: number;
  eventType: string;
  body: TypedObjectBodyV1;
  createdAtMs: number;
};
export type TypedObjectEventPageV1 = {
  events: TypedObjectEventV1[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type TypedObjectListPageV1 = {
  objects: TypedObjectV1[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type TypedObjectDeleteCommitV1 = { revision: number; deleted: true };
export type TypedObjectAliasBindingV1 = { handle: string; alias: string };
export type TypedObjectScopeMemberV1 = { objectType: string; handle: string; revision: number; deleted: boolean };
export type TypedObjectScopeV1 = { handle: string; scopeType: string; revision: number; members: TypedObjectScopeMemberV1[] };
export type TypedObjectScopeCommitV1 = { scopeHandle: string; revision: number; memberCount: number };
export type TypedObjectResultV1 = {
  schema: "plugin-object:v1";
  object?: TypedObjectV1;
  commit?: TypedObjectCommitV1 | TypedObjectDeleteCommitV1 | TypedObjectScopeCommitV1;
  page?: TypedObjectEventPageV1 | TypedObjectListPageV1;
  scope?: TypedObjectScopeV1;
  aliasBinding?: TypedObjectAliasBindingV1;
};
export type TypedObjectPendingEventV1 = { eventType: string; body: TypedObjectBodyV1 };

type CreateInput = { objectType: string; schemaVersion: number; body: TypedObjectBodyV1; idempotencyKey: string; alias?: string };
type ReadInput = { objectType: string; handle: string };
type ReadByAliasInput = { objectType: string; alias: string };
type AttachAliasInput = { objectType: string; handle: string; alias: string; idempotencyKey: string };
type CommitInput = { objectType: string; handle: string; expectedRevision: number; body: TypedObjectBodyV1; events: readonly TypedObjectPendingEventV1[]; idempotencyKey: string };
type EventPageInput = { objectType: string; handle: string; afterCursor?: string; limit?: number };
type ListInput = { objectType: string; schemaVersion: number; afterCursor?: string; limit?: number; aliases?: readonly string[]; handles?: readonly string[] };
type DeleteInput = { objectType: string; handle: string; expectedRevision: number; idempotencyKey: string };
type ScopeReadInput = { scopeType: string; scopeHandle: string };
type ScopeCommitInput = { scopeType: string; scopeHandle?: string; expectedRevision: number; members: readonly { objectType: string; handle: string }[]; idempotencyKey: string };
type Operation = "create" | "read" | "readAlias" | "attachAlias" | "commit" | "eventPage" | "list" | "delete" | "scopeRead" | "scopeCommit";
type Payload = {
  version: 1;
  operation: Operation;
  objectType?: string;
  scopeType?: string;
  schemaVersion?: number;
  handle?: string;
  alias?: string;
  scopeHandle?: string;
  expectedRevision?: number;
  body?: TypedObjectBodyV1;
  events?: readonly TypedObjectPendingEventV1[];
  members?: readonly { objectType: string; handle: string }[];
  idempotencyKey?: string;
  afterCursor?: string;
  cursor?: string;
  limit?: number;
  aliases?: readonly string[];
  handles?: readonly string[];
};
type Send = (request: PluginRequestV1<Payload>) => Promise<PluginResponseV1<TypedObjectResultV1>>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safePositive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Validate JSON data without invoking accessors or accepting JS-only values. */
function assertPlainJson(value: unknown, maxBytes: number): asserts value is TypedObjectBodyV1 {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) throw new Error("typed_object_request_invalid");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("typed_object_request_invalid");
      return;
    }
    if (typeof item !== "object") throw new Error("typed_object_request_invalid");
    if (seen.has(item)) throw new Error("typed_object_request_invalid");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length) throw new Error("typed_object_request_invalid");
        const keys = Object.keys(item);
        const names = Object.getOwnPropertyNames(item);
        if (keys.length !== item.length || names.length !== item.length + 1 || keys.some((key, index) => key !== String(index))) throw new Error("typed_object_request_invalid");
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("typed_object_request_invalid");
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("typed_object_request_invalid");
      if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length) throw new Error("typed_object_request_invalid");
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("typed_object_request_invalid");
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(item);
    }
  };
  if (!isRecord(value)) throw new Error("typed_object_request_invalid");
  visit(value, 0);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error("typed_object_request_invalid"); }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error("typed_object_request_invalid");
}

function validIdentity(objectType: string): boolean { return typeof objectType === "string" && TOKEN.test(objectType); }
function validHandle(handle: string): boolean { return typeof handle === "string" && HANDLE.test(handle); }
function validIdempotencyKey(key: string): boolean { return typeof key === "string" && IDEMPOTENCY_KEY.test(key); }
function validAlias(alias: string): boolean { return typeof alias === "string" && ALIAS.test(alias); }

function parseObject(value: unknown): TypedObjectV1 {
  if (!isRecord(value) || !(exact(value, ["handle", "schemaVersion", "revision", "body", "deleted"])
      || exact(value, ["handle", "alias", "schemaVersion", "revision", "body", "deleted"]))
      || typeof value.handle !== "string" || !HANDLE.test(value.handle)
      || (Object.hasOwn(value, "alias") && (typeof value.alias !== "string" || !ALIAS.test(value.alias)))
      || !safePositive(value.schemaVersion) || value.schemaVersion > 0xffff_ffff || !safePositive(value.revision) || typeof value.deleted !== "boolean") {
    throw new Error("typed_object_response_invalid");
  }
  try { assertPlainJson(value.body, MAX_OBJECT_BYTES); } catch { throw new Error("typed_object_response_invalid"); }
  return value as unknown as TypedObjectV1;
}

function parseCommit(value: unknown): TypedObjectCommitV1 {
  if (!isRecord(value) || !exact(value, ["revision", "eventIds"]) || !safePositive(value.revision)
      || !Array.isArray(value.eventIds) || value.eventIds.length > MAX_EVENTS_PER_COMMIT
      || value.eventIds.some(id => typeof id !== "string" || !EVENT_ID.test(id))
      || new Set(value.eventIds).size !== value.eventIds.length) throw new Error("typed_object_response_invalid");
  return value as unknown as TypedObjectCommitV1;
}

function parseEvent(value: unknown): TypedObjectEventV1 {
  if (!isRecord(value) || !exact(value, ["eventId", "revision", "eventType", "body", "createdAtMs"])
      || typeof value.eventId !== "string" || !EVENT_ID.test(value.eventId)
      || !safePositive(value.revision) || typeof value.eventType !== "string" || !TOKEN.test(value.eventType)
      || !safeCount(value.createdAtMs)) throw new Error("typed_object_response_invalid");
  try { assertPlainJson(value.body, MAX_EVENT_BYTES); } catch { throw new Error("typed_object_response_invalid"); }
  return value as unknown as TypedObjectEventV1;
}

function parsePage(value: unknown, limit: number): TypedObjectEventPageV1 {
  if (!isRecord(value) || !exact(value, ["events", "nextCursor", "hasMore"]) || !Array.isArray(value.events)
      || value.events.length > limit || typeof value.hasMore !== "boolean"
      || (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !EVENT_ID.test(value.nextCursor)))) throw new Error("typed_object_response_invalid");
  const events = value.events.map(parseEvent);
  const expectedCursor = events.at(-1)?.eventId ?? null;
  if (value.nextCursor !== expectedCursor || (value.hasMore && events.length === 0)) throw new Error("typed_object_response_invalid");
  return { ...value, events } as TypedObjectEventPageV1;
}

function parseListPage(value: unknown, limit: number, schemaVersion: number): TypedObjectListPageV1 {
  if (!isRecord(value) || !exact(value, ["objects", "nextCursor", "hasMore"]) || !Array.isArray(value.objects)
      || value.objects.length > limit || typeof value.hasMore !== "boolean"
      || (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !HANDLE.test(value.nextCursor)))) throw new Error("typed_object_response_invalid");
  const objects = value.objects.map(parseObject);
  if (objects.some(object => object.schemaVersion !== schemaVersion) || new Set(objects.map(object => object.handle)).size !== objects.length
      || (value.hasMore && (objects.length === 0 || value.nextCursor !== objects.at(-1)?.handle))
      || (!value.hasMore && value.nextCursor !== null)) throw new Error("typed_object_response_invalid");
  return { ...value, objects } as TypedObjectListPageV1;
}

function parseDeleteCommit(value: unknown, expectedRevision: number): TypedObjectDeleteCommitV1 {
  if (!isRecord(value) || !exact(value, ["revision", "deleted"]) || !safePositive(value.revision)
      || value.revision !== expectedRevision + 1 || value.deleted !== true) throw new Error("typed_object_response_invalid");
  return value as unknown as TypedObjectDeleteCommitV1;
}

function parseScopeMember(value: unknown): TypedObjectScopeMemberV1 {
  if (!isRecord(value) || !exact(value, ["objectType", "handle", "revision", "deleted"])
      || typeof value.objectType !== "string" || !TOKEN.test(value.objectType) || typeof value.handle !== "string" || !HANDLE.test(value.handle)
      || !safePositive(value.revision) || typeof value.deleted !== "boolean") throw new Error("typed_object_response_invalid");
  return value as unknown as TypedObjectScopeMemberV1;
}

function parseScope(value: unknown, scopeType: string, scopeHandle: string): TypedObjectScopeV1 {
  if (!isRecord(value) || !exact(value, ["handle", "scopeType", "revision", "members"])
      || typeof value.handle !== "string" || !SCOPE_HANDLE.test(value.handle) || value.handle !== scopeHandle
      || value.scopeType !== scopeType || !safePositive(value.revision) || !Array.isArray(value.members) || value.members.length > 4_000) {
    throw new Error("typed_object_response_invalid");
  }
  const members = value.members.map(parseScopeMember);
  const memberKeys = members.map(member => `${member.objectType}\u0000${member.handle}`);
  if (new Set(memberKeys).size !== memberKeys.length) throw new Error("typed_object_response_invalid");
  return { ...value, members } as TypedObjectScopeV1;
}

function parseScopeCommit(value: unknown, expectedRevision: number, expectedHandle?: string, expectedCount?: number): TypedObjectScopeCommitV1 {
  if (!isRecord(value) || !exact(value, ["scopeHandle", "revision", "memberCount"])
      || typeof value.scopeHandle !== "string" || !SCOPE_HANDLE.test(value.scopeHandle)
      || (expectedHandle !== undefined && value.scopeHandle !== expectedHandle)
      || !safePositive(value.revision) || value.revision !== expectedRevision + 1
      || !safeCount(value.memberCount) || value.memberCount > 4_000
      || (expectedCount !== undefined && value.memberCount !== expectedCount)) throw new Error("typed_object_response_invalid");
  return value as unknown as TypedObjectScopeCommitV1;
}

function parseAliasBinding(value: unknown, handle: string, alias: string): TypedObjectAliasBindingV1 {
  if (!isRecord(value) || !exact(value, ["handle", "alias"]) || value.handle !== handle || value.alias !== alias
      || !validHandle(value.handle) || !validAlias(value.alias)) throw new Error("typed_object_response_invalid");
  return { handle: value.handle, alias: value.alias };
}

function parseResult(value: unknown, operation: Operation, options: { expectedRevision?: number; expectedAlias?: string; expectedHandle?: string; limit?: number; schemaVersion?: number; scopeType?: string; scopeHandle?: string; memberCount?: number } = {}): TypedObjectResultV1 {
  const keys = operation === "create" || operation === "read" || operation === "readAlias" ? ["schema", "object"]
    : operation === "attachAlias" ? ["schema", "aliasBinding"]
    : operation === "commit" || operation === "delete" || operation === "scopeCommit" ? ["schema", "commit"]
      : operation === "scopeRead" ? ["schema", "scope"] : ["schema", "page"];
  if (!isRecord(value) || !exact(value, keys) || value.schema !== SCHEMA) throw new Error("typed_object_response_invalid");
  if (operation === "create" || operation === "read" || operation === "readAlias") {
    const object = parseObject(value.object);
    if ((operation === "create" && object.revision !== 1)
        || ((operation === "create" || operation === "readAlias") && object.alias !== options.expectedAlias)
        || (options.schemaVersion !== undefined && object.schemaVersion !== options.schemaVersion)) throw new Error("typed_object_response_invalid");
    return { schema: SCHEMA, object };
  }
  if (operation === "attachAlias") return { schema: SCHEMA, aliasBinding: parseAliasBinding(value.aliasBinding, options.expectedHandle!, options.expectedAlias!) };
  if (operation === "commit") {
    const commit = parseCommit(value.commit);
    if (options.expectedRevision !== undefined && commit.revision !== options.expectedRevision + 1) throw new Error("typed_object_response_invalid");
    return { schema: SCHEMA, commit };
  }
  if (operation === "delete") return { schema: SCHEMA, commit: parseDeleteCommit(value.commit, options.expectedRevision!) };
  if (operation === "scopeRead") return { schema: SCHEMA, scope: parseScope(value.scope, options.scopeType!, options.scopeHandle!) };
  if (operation === "scopeCommit") return { schema: SCHEMA, commit: parseScopeCommit(value.commit, options.expectedRevision!, options.scopeHandle, options.memberCount) };
  if (operation === "list") return { schema: SCHEMA, page: parseListPage(value.page, options.limit!, options.schemaVersion!) };
  return { schema: SCHEMA, page: parsePage(value.page, options.limit ?? 100) };
}

export function createTypedObjectClient(instanceId: string, send: Send) {
  if (typeof instanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId) || typeof send !== "function") throw new Error("typed_object_client_invalid");
  let sequence = 0;

  async function request(operation: Operation, payload: Payload, options: { expectedRevision?: number; expectedAlias?: string; expectedHandle?: string; limit?: number; schemaVersion?: number; scopeType?: string; scopeHandle?: string; memberCount?: number } = {}): Promise<TypedObjectResultV1> {
    const requestId = `typed-object-${++sequence}`;
    const response = await send({ version: 1, instanceId, requestId, method: METHOD, payload });
    if (!response || response.version !== 1 || response.requestId !== requestId) throw new Error("plugin_response_invalid");
    if (!response.ok || !response.result) throw new Error(response.error?.code ?? "plugin_request_failed");
    return parseResult(response.result, operation, options);
  }

  return {
    async create(input: CreateInput): Promise<TypedObjectV1> {
      if (!input || !validIdentity(input.objectType) || !safePositive(input.schemaVersion) || input.schemaVersion > 0xffff_ffff
          || !validIdempotencyKey(input.idempotencyKey) || (input.alias !== undefined && !validAlias(input.alias))) throw new Error("typed_object_request_invalid");
      assertPlainJson(input.body, MAX_OBJECT_BYTES);
      const result = await request("create", { version: 1, operation: "create", objectType: input.objectType,
        schemaVersion: input.schemaVersion, body: input.body, idempotencyKey: input.idempotencyKey,
        ...(input.alias === undefined ? {} : { alias: input.alias }) }, { schemaVersion: input.schemaVersion, expectedAlias: input.alias });
      return result.object!;
    },
    async read(input: ReadInput): Promise<TypedObjectV1> {
      if (!input || !validIdentity(input.objectType) || !validHandle(input.handle)) throw new Error("typed_object_request_invalid");
      const result = await request("read", { version: 1, operation: "read", objectType: input.objectType, handle: input.handle });
      return result.object!;
    },
    async readByAlias(input: ReadByAliasInput): Promise<TypedObjectV1> {
      if (!input || !validIdentity(input.objectType) || !validAlias(input.alias)) throw new Error("typed_object_request_invalid");
      const result = await request("readAlias", { version: 1, operation: "readAlias", objectType: input.objectType, alias: input.alias },
        { expectedAlias: input.alias });
      return result.object!;
    },
    async attachAlias(input: AttachAliasInput): Promise<TypedObjectAliasBindingV1> {
      if (!input || !validIdentity(input.objectType) || !validHandle(input.handle) || !validAlias(input.alias)
          || !validIdempotencyKey(input.idempotencyKey)) throw new Error("typed_object_request_invalid");
      const result = await request("attachAlias", { version: 1, operation: "attachAlias", objectType: input.objectType,
        handle: input.handle, alias: input.alias, idempotencyKey: input.idempotencyKey },
      { expectedHandle: input.handle, expectedAlias: input.alias });
      return result.aliasBinding!;
    },
    async commit(input: CommitInput): Promise<TypedObjectCommitV1> {
      if (!input || !validIdentity(input.objectType) || !validHandle(input.handle) || !safePositive(input.expectedRevision)
          || !validIdempotencyKey(input.idempotencyKey) || !Array.isArray(input.events) || input.events.length > MAX_EVENTS_PER_COMMIT) throw new Error("typed_object_request_invalid");
      assertPlainJson(input.body, MAX_OBJECT_BYTES);
      for (const event of input.events) {
        if (!isRecord(event) || !exact(event, ["eventType", "body"]) || typeof event.eventType !== "string" || !TOKEN.test(event.eventType)) throw new Error("typed_object_request_invalid");
        assertPlainJson(event.body, MAX_EVENT_BYTES);
      }
      const result = await request("commit", { version: 1, operation: "commit", objectType: input.objectType,
        handle: input.handle, expectedRevision: input.expectedRevision, body: input.body, events: input.events,
        idempotencyKey: input.idempotencyKey }, { expectedRevision: input.expectedRevision });
      return result.commit as TypedObjectCommitV1;
    },
    async readEvents(input: EventPageInput): Promise<TypedObjectEventPageV1> {
      const limit = input?.limit ?? 100;
      if (!input || !validIdentity(input.objectType) || !validHandle(input.handle) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE
          || (input.afterCursor !== undefined && (typeof input.afterCursor !== "string" || !EVENT_ID.test(input.afterCursor)))) throw new Error("typed_object_request_invalid");
      const result = await request("eventPage", { version: 1, operation: "eventPage", objectType: input.objectType,
        handle: input.handle, ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }), limit }, { limit });
      return result.page as TypedObjectEventPageV1;
    },
    async list(input: ListInput): Promise<TypedObjectListPageV1> {
      const aliases = input?.aliases;
      const handles = input?.handles;
      const filter = aliases ?? handles;
      const limit = input?.limit ?? (filter ? Math.max(1, filter.length) : undefined);
      if (!input || !validIdentity(input.objectType) || !safePositive(input.schemaVersion) || input.schemaVersion > 0xffff_ffff
          || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE))
          || (input.afterCursor !== undefined && (typeof input.afterCursor !== "string" || !HANDLE.test(input.afterCursor)))
          || (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > MAX_PAGE_SIZE
            || aliases.some(alias => !validAlias(alias)) || new Set(aliases).size !== aliases.length || input.afterCursor !== undefined))
          || (handles !== undefined && (!Array.isArray(handles) || handles.length > MAX_PAGE_SIZE
            || handles.some(handle => !validHandle(handle)) || new Set(handles).size !== handles.length || input.afterCursor !== undefined))
          || (aliases !== undefined && handles !== undefined)) {
        throw new Error("typed_object_request_invalid");
      }
      const result = await request("list", { version: 1, operation: "list", objectType: input.objectType,
        schemaVersion: input.schemaVersion, ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }), ...(limit === undefined ? {} : { limit }),
        ...(aliases === undefined ? {} : { aliases }), ...(handles === undefined ? {} : { handles }) },
      { limit: limit ?? MAX_PAGE_SIZE, schemaVersion: input.schemaVersion });
      return result.page as TypedObjectListPageV1;
    },
    async delete(input: DeleteInput): Promise<TypedObjectDeleteCommitV1> {
      if (!input || !validIdentity(input.objectType) || !validHandle(input.handle) || !safePositive(input.expectedRevision)
          || !validIdempotencyKey(input.idempotencyKey)) throw new Error("typed_object_request_invalid");
      const result = await request("delete", { version: 1, operation: "delete", objectType: input.objectType,
        handle: input.handle, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey },
      { expectedRevision: input.expectedRevision });
      return result.commit as TypedObjectDeleteCommitV1;
    },
    async readScope(input: ScopeReadInput): Promise<TypedObjectScopeV1> {
      if (!input || !validIdentity(input.scopeType) || typeof input.scopeHandle !== "string" || !SCOPE_HANDLE.test(input.scopeHandle)) throw new Error("typed_object_request_invalid");
      const result = await request("scopeRead", { version: 1, operation: "scopeRead", scopeType: input.scopeType,
        scopeHandle: input.scopeHandle }, { scopeType: input.scopeType, scopeHandle: input.scopeHandle });
      return result.scope!;
    },
    async commitScope(input: ScopeCommitInput): Promise<TypedObjectScopeCommitV1> {
      if (!input || !validIdentity(input.scopeType) || (input.scopeHandle !== undefined && (typeof input.scopeHandle !== "string" || !SCOPE_HANDLE.test(input.scopeHandle)))
          || !safeCount(input.expectedRevision) || !validIdempotencyKey(input.idempotencyKey)
          || !Array.isArray(input.members) || input.members.length > 4_000) throw new Error("typed_object_request_invalid");
      const members = input.members.map(member => {
        if (!isRecord(member) || !exact(member, ["objectType", "handle"]) || typeof member.objectType !== "string"
            || !TOKEN.test(member.objectType) || typeof member.handle !== "string" || !HANDLE.test(member.handle)) throw new Error("typed_object_request_invalid");
        return { objectType: member.objectType, handle: member.handle } as { objectType: string; handle: string };
      });
      const keys = members.map(member => `${member.objectType}\u0000${member.handle}`);
      if (new Set(keys).size !== keys.length) throw new Error("typed_object_request_invalid");
      const result = await request("scopeCommit", { version: 1, operation: "scopeCommit", scopeType: input.scopeType,
        ...(input.scopeHandle === undefined ? {} : { scopeHandle: input.scopeHandle }), expectedRevision: input.expectedRevision,
        members, idempotencyKey: input.idempotencyKey }, { expectedRevision: input.expectedRevision,
        scopeHandle: input.scopeHandle, memberCount: members.length });
      return result.commit as TypedObjectScopeCommitV1;
    },
  };
}
