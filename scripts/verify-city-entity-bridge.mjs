#!/usr/bin/env node
// Host → City entity envelope + building construction / ghost / fail-flash apply path.
// No WebGL: pure parse/dispatch/reducer + part-reveal + edit-state math.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const {
  parseEntityChanged, dispatchEntityChanged, ENTITY_CHANGED_EVENT, ENTITY_CHANGED_TYPE,
} = await loadCity({
  "engine/entityEvents.ts": ["parseEntityChanged", "dispatchEntityChanged", "ENTITY_CHANGED_EVENT", "ENTITY_CHANGED_TYPE"],
});
const {
  parseBuildingChanged, applyBuildingEvent, entityChangedFromBuilding,
  partReveal, visiblePartCount, constructionOrder, parseKitModel,
} = await loadCity({
  "engine/sessionKitConstruction.ts": [
    "parseBuildingChanged", "applyBuildingEvent", "entityChangedFromBuilding",
    "partReveal", "visiblePartCount", "constructionOrder", "parseKitModel",
  ],
});
const {
  parseBuildingEdit, applyEditEvent, editPresentation, flashEnvelope,
  GHOST_OPACITY, REJECT_FLASH_MS, isFlashRule,
} = await loadCity({
  "engine/sessionKitEditState.ts": [
    "parseBuildingEdit", "applyEditEvent", "editPresentation", "flashEnvelope",
    "GHOST_OPACITY", "REJECT_FLASH_MS", "isFlashRule",
  ],
});

const ASSET = `ca_${"a".repeat(32)}`;
const EVENT = `be_${"b".repeat(32)}`;
const SESSION = `sr_${"c".repeat(32)}`;
const model = {
  kit_version: "session-kit/v1",
  parts: [
    { id: "cap", kind: "cone", role: "roof", at: [0, 2, 0], size: [2, 1.5, 2] },
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [3, 2, 3] },
  ],
};

const envelope = {
  type: ENTITY_CHANGED_TYPE,
  schema_version: 1,
  entity_kind: "building",
  entity_id: ASSET,
  action: "set",
  revision: 1,
  event_id: EVENT,
  session_id: SESSION,
  source: "override",
  model,
  asset_ref: ASSET,
  build_event_id: EVENT,
  kind: "set",
};

assert.equal(ENTITY_CHANGED_EVENT, "__AV_PLUGIN_ENTITY_CHANGED__");
assert.equal(ENTITY_CHANGED_TYPE, "CityEntityChanged");

const parsed = parseEntityChanged(envelope);
assert.ok(parsed);
assert.equal(parsed.entity_kind, "building");
assert.equal(parsed.entity_id, ASSET);
assert.equal(parsed.action, "set");
assert.equal(parsed.event_id, EVENT);
assert.equal(parsed.revision, 1);

assert.equal(parseEntityChanged({ ...envelope, type: "CityBuildingChanged" }), null, "building-only type must not parse");
assert.equal(parseEntityChanged({ ...envelope, entity_kind: "" }), null, "kind is required");
assert.ok(parseEntityChanged({
  type: ENTITY_CHANGED_TYPE, entity_kind: "road", entity_id: "rd_1",
  action: "set", revision: 1, event_id: "ev_1",
}), "road envelope must parse so the channel stays reusable");

const kinds = [];
assert.equal(dispatchEntityChanged(parsed, { building: () => kinds.push("building") }), true);
assert.deepEqual(kinds, ["building"]);
const vehicle = parseEntityChanged({ type: ENTITY_CHANGED_TYPE, entity_kind: "vehicle", entity_id: "vh_1", action: "set", revision: 1, event_id: "ev_2" });
assert.ok(vehicle);
assert.equal(dispatchEntityChanged(vehicle, { building: () => kinds.push("building") }), false, "unknown kinds are ignored");
assert.deepEqual(kinds, ["building"]);

const building = parseBuildingChanged(envelope);
assert.ok(building);
assert.equal(building.entity_kind, "building");
assert.equal(building.asset_ref, ASSET);
const ordered = constructionOrder(building.model.parts);
assert.deepEqual(ordered.map((part) => part.id), ["base", "cap"]);

const applied = applyBuildingEvent(null, building, SESSION, true);
assert.ok(applied);
assert.equal(applied.animate, true);
assert.equal(applied.kind, "set");
assert.equal(applied.parts.length, 2);
assert.equal(applied.buildEventId, EVENT);
assert.equal(applyBuildingEvent(applied, building, SESSION, true), applied, "same event_id is a no-op");

const older = parseBuildingChanged({ ...envelope, revision: 0, event_id: "be_old", build_event_id: "be_old" });
assert.equal(applyBuildingEvent(applied, older, SESSION, true), applied, "older revision ignored");

const reset = parseBuildingChanged({
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "reset", revision: 2, event_id: "be_reset", kind: "reset", source: "default",
});
const cleared = applyBuildingEvent(applied, reset, SESSION, true);
assert.equal(cleared.kind, "reset");
assert.equal(cleared.parts.length, 0);
assert.equal(cleared.animate, true);

assert.equal(parseBuildingChanged({
  type: ENTITY_CHANGED_TYPE, entity_kind: "road", entity_id: ASSET,
  action: "set", revision: 1, event_id: EVENT, model,
}), null, "road must not enter the building handler");
assert.equal(parseBuildingChanged({
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "preview", revision: 1, event_id: "ui_preview_1", model,
}), null, "preview must not enter the persist construction reducer");
assert.equal(parseBuildingChanged({
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "reject", revision: 1, event_id: "ui_reject_1",
  error: { rule: "invalid_model" },
}), null, "reject must not enter the persist construction reducer");

const fromRow = entityChangedFromBuilding({
  asset_ref: ASSET, revision: 1, kind: "set", build_event_id: EVENT, model,
});
assert.equal(fromRow.type, ENTITY_CHANGED_TYPE);
assert.equal(fromRow.entity_kind, "building");
assert.equal(fromRow.event_id, EVENT);

assert.equal(visiblePartCount(0, 3), 0);
assert.equal(visiblePartCount(0.1, 3), 1);
assert.equal(visiblePartCount(0.5, 3), 2);
assert.equal(visiblePartCount(1, 3), 3);
assert.equal(partReveal(0.2, 0, 4), 0.8);
assert.equal(partReveal(0.2, 1, 4), 0);
assert.equal(partReveal(0.5, 1, 4), 1);
assert.equal(partReveal(0.5, 2, 4), 0);

const aliasOnly = parseEntityChanged({
  entity_kind: "building", asset_ref: ASSET, kind: "set", revision: 4,
  build_event_id: EVENT, type: ENTITY_CHANGED_TYPE, model,
});
assert.equal(aliasOnly.entity_id, ASSET);
assert.equal(aliasOnly.action, "set");
assert.equal(aliasOnly.event_id, EVENT);

assert.ok(parseKitModel({
  kit_version: "session-kit/v1",
  parts: [
    { id: "door", kind: "box", role: "door", at: [0, 0, 3], size: [1.2, 2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 3, 3], size: [1.4, 1.2, 0.15] },
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [3, 2, 3] },
  ],
}), "catalog door/window roles must parse so ghost/construction can render default kits");

const previewEnvelope = {
  type: ENTITY_CHANGED_TYPE, schema_version: 1, entity_kind: "building",
  entity_id: ASSET, action: "preview", revision: 1, event_id: "ui_preview_test1",
  session_id: SESSION, source: "preview", ephemeral: true, persisted: false, model,
};
const preview = parseBuildingEdit(previewEnvelope);
assert.ok(preview);
assert.equal(preview.action, "preview");
assert.equal(dispatchEntityChanged(preview, { building: () => kinds.push("preview") }), true);
assert.deepEqual(kinds.slice(-1), ["preview"]);

const ghost = applyEditEvent(null, preview, SESSION, 0);
assert.ok(ghost);
assert.equal(ghost.kind, "ghost");
assert.equal(ghost.parts.length, 2);
assert.equal(editPresentation(ghost, 0).opacity, GHOST_OPACITY);
assert.equal(editPresentation(ghost, 0).active, true);
assert.equal(applyEditEvent(ghost, preview, SESSION, 10), ghost, "same preview event_id is a no-op");

const rejectEnvelope = {
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "reject", revision: 1, event_id: "ui_reject_test1",
  source: "reject", ephemeral: true,
  error: { kind: "validation", rule: "invalid_model", message: "pillar" },
};
const reject = parseBuildingEdit(rejectEnvelope);
assert.ok(reject);
const flash = applyEditEvent(ghost, reject, SESSION, 100);
assert.ok(flash);
assert.equal(flash.kind, "reject");
assert.equal(flash.rule, "invalid_model");
assert.equal(flash.startedAtMs, 100);
assert.equal(editPresentation(flash, 100).active, true);
assert.ok(editPresentation(flash, 100 + REJECT_FLASH_MS / 2).opacity > 0.2);
assert.equal(editPresentation(flash, 100 + REJECT_FLASH_MS).active, false);
assert.equal(flashEnvelope(-1).active, false);
assert.equal(flashEnvelope(REJECT_FLASH_MS).active, false);

assert.equal(parseBuildingEdit({
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "reject", revision: 1, event_id: "ui_reject_overlap",
  error: { rule: "overlap" },
}), null, "overlap is not a City fail-flash rule");
assert.equal(isFlashRule("detail_regression"), true);
assert.equal(isFlashRule("disconnected_part"), true);
assert.equal(isFlashRule("massing_drift"), true);
assert.equal(isFlashRule("revision_conflict"), false);
assert.equal(isFlashRule("massing_shift"), false, "warnings do not flash");

const regression = parseBuildingEdit({
  type: ENTITY_CHANGED_TYPE, entity_kind: "building", entity_id: ASSET,
  action: "reject", revision: 2, event_id: "ui_reject_detail",
  error: { rule: "detail_regression" },
});
assert.ok(regression);
assert.equal(applyEditEvent(null, regression, SESSION, 0).rule, "detail_regression");

const parsedPreview = parseEntityChanged(previewEnvelope);
assert.equal(parsedPreview.action, "preview");
const parsedReject = parseEntityChanged(rejectEnvelope);
assert.equal(parsedReject.action, "reject");

console.log("verify-city-entity-bridge: ok");
