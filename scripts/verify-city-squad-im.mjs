#!/usr/bin/env node
// Squad IM envelope parse/filter/claim tint reducer. No WebGL.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const {
  parseSquadEnvelope, applySquadEnvelope, emptyFeed, visibleFeed, DEFAULT_KIND_FILTER,
  envelopeAssetRef, envelopeSummary, actorLabel, claimsFromRows, expireClaims, SQUAD_EVENT, isWriteKind,
} = await loadCity({
  "engine/squadEvents.ts": [
    "parseSquadEnvelope", "applySquadEnvelope", "emptyFeed", "visibleFeed", "DEFAULT_KIND_FILTER",
    "envelopeAssetRef", "envelopeSummary", "actorLabel", "claimsFromRows", "expireClaims", "SQUAD_EVENT", "isWriteKind",
  ],
});

const SESSION = `sr_${"c".repeat(32)}`;
const ASSET = `ca_${"a".repeat(32)}`;
const SIBLING = `ca_${"b".repeat(32)}`;

assert.equal(SQUAD_EVENT, "__AV_PLUGIN_SQUAD_EVENT__");
assert.equal(DEFAULT_KIND_FILTER.chat, false);
assert.equal(DEFAULT_KIND_FILTER.observe, false);
assert.equal(DEFAULT_KIND_FILTER.set, true);
assert.equal(DEFAULT_KIND_FILTER.reset, true);
assert.equal(DEFAULT_KIND_FILTER.preview, true);

const claim = parseSquadEnvelope({
  v: 1, id: "evt_claim1", ts: 1_761_180_000, session_id: SESSION,
  agent_id: "nano", agent_name: "Nano", kind: "claim",
  payload: { asset_ref: ASSET, ttl_sec: 90, expires_at: 1_761_180_090 },
});
assert.ok(claim);
assert.equal(claim.kind, "claim");
assert.equal(envelopeAssetRef(claim), ASSET);
assert.equal(parseSquadEnvelope({ ...claim, v: 2 }), null);
assert.equal(parseSquadEnvelope({ type: "CityEntityChanged", kind: "set" }), null);

let feed = applySquadEnvelope(emptyFeed(), claim, 1_761_180_000);
assert.equal(feed.claims[ASSET].agentId, "nano");
const chat = parseSquadEnvelope({
  v: 1, id: "evt_chat1", ts: 1_761_180_001, session_id: SESSION,
  agent_id: "nano", agent_name: "Nano", kind: "chat", payload: { text: "heads up" },
});
feed = applySquadEnvelope(feed, chat, 1_761_180_001);
assert.equal(visibleFeed(feed.items, DEFAULT_KIND_FILTER).length, 1, "chat off by default");
assert.equal(visibleFeed(feed.items, { ...DEFAULT_KIND_FILTER, chat: true }).length, 2);

const stolen = parseSquadEnvelope({
  v: 1, id: "evt_claim2", ts: 1_761_180_010, session_id: SESSION,
  agent_id: "byte", agent_name: "Byte", kind: "claim",
  payload: { asset_ref: ASSET, ttl_sec: 90, expires_at: 1_761_180_100 },
});
feed = applySquadEnvelope(feed, stolen, 1_761_180_010);
assert.equal(feed.claims[ASSET].agentId, "byte");

const set = parseSquadEnvelope({
  v: 1, id: "evt_set1", ts: 1_761_180_020, session_id: SESSION,
  agent_id: "city-mcp", agent_name: "City MCP", kind: "set",
  payload: { asset_ref: ASSET, ok: true, revision: 1, build_event_id: `be_${"b".repeat(32)}` },
});
feed = applySquadEnvelope(feed, set, 1_761_180_020);
assert.equal(feed.claims[ASSET], undefined, "set_won / set envelope clears tint");
assert.equal(isWriteKind("set"), true);
assert.equal(isWriteKind("chat"), false);
assert.equal(actorLabel(set), "别的");
assert.equal(actorLabel(claim), "Nano");
assert.match(envelopeSummary(set), /Saved revision 1/);
assert.doesNotMatch(envelopeSummary(set), /set ok/);

const mcp = { agent_id: "city-mcp", agent_name: "City MCP" };
const nano = { agent_id: "nano", agent_name: "Nano" };
const byte = { agent_id: "byte", agent_name: "Byte" };
const envelopeOf = (id, ts, kind, payload, actor = mcp) => parseSquadEnvelope({
  v: 1, id, ts, session_id: SESSION, ...actor, kind, payload,
});
let iso = applySquadEnvelope(emptyFeed(), envelopeOf("evt_iso_ca", 1_761_180_100, "claim", {
  asset_ref: ASSET, ttl_sec: 90, expires_at: 1_761_180_190,
}, nano), 1_761_180_100);
iso = applySquadEnvelope(iso, envelopeOf("evt_iso_cb", 1_761_180_101, "claim", {
  asset_ref: SIBLING, ttl_sec: 90, expires_at: 1_761_180_191,
}, byte), 1_761_180_101);
iso = applySquadEnvelope(iso, envelopeOf("evt_iso_set2", 1_761_180_110, "set", {
  asset_ref: ASSET, ok: true, revision: 2,
}), 1_761_180_110);
assert.equal(iso.claims[ASSET], undefined);
assert.equal(iso.claims[SIBLING].agentId, "byte", "sibling asset_ref claim isolated");
iso = applySquadEnvelope(iso, envelopeOf("evt_iso_ca2", 1_761_180_120, "claim", {
  asset_ref: ASSET, ttl_sec: 90, expires_at: 1_761_180_210,
}, nano), 1_761_180_120);
assert.equal(iso.claims[ASSET].agentId, "nano");
const claimsBeforeStale = { ...iso.claims };
const stale = envelopeOf("evt_iso_set1", 1_761_180_105, "set", { asset_ref: ASSET, ok: true, revision: 1 });
iso = applySquadEnvelope(iso, stale, 1_761_180_130);
assert.equal(iso.items.some((item) => item.id === "evt_iso_set1"), false, "stale lower revision is a no-op");
assert.equal(iso.claims[ASSET].agentId, "nano", "stale set must not clear a later claim on the same lot");
assert.equal(iso.claims[SIBLING].agentId, "byte", "sibling asset_ref never mutated");
assert.deepEqual(iso.claims, claimsBeforeStale);
assert.equal(iso.revisions[ASSET].revision, 2);
assert.equal(iso.revisions[SIBLING], undefined, "soft claim does not invent a revision watermark");
const olderEqual = envelopeOf("evt_iso_set2_old", 1_761_180_090, "set", { asset_ref: ASSET, ok: true, revision: 2 });
iso = applySquadEnvelope(iso, olderEqual, 1_761_180_131);
assert.equal(iso.items.some((item) => item.id === "evt_iso_set2_old"), false, "equal revision with older ts is a no-op");
assert.equal(iso.claims[SIBLING].agentId, "byte");

const rows = claimsFromRows([{
  session_id: SESSION, asset_ref: ASSET, agent_id: "nano", agent_name: "Nano", expires_at: 9_999_999_999,
}], 1);
assert.equal(rows[ASSET].agentId, "nano");
assert.deepEqual(expireClaims(rows, 9_999_999_999), {});

console.log("verify-city-squad-im: ok");
