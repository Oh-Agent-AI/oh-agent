import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_TEMPLATES_V1, type CityLayoutV1 } from "@oh-agent/city-sdk";
import { mountChoices, mountSlotDiagnostics, readMountBindings } from "../src/features/project/mountEditorModel.ts";

test("mount editor derives the entry and targets from the saved flight template", () => {
  const layout: CityLayoutV1 = {
    schemaVersion: 1, id: "demo", coordinateSystem: "city-local-m-v1",
    anchors: [
      { id: "street", kind: "spawn", capabilities: ["drive"], geometryRef: "street" },
      { id: "airport", kind: "spawn", capabilities: ["fly"], geometryRef: "airport" },
      { id: "corner", kind: "zone", capabilities: ["drive"], geometryRef: "corner" },
      { id: "gate", kind: "zone", capabilities: ["fly"], geometryRef: "gate" },
    ],
  };
  const flight = CREATOR_TEMPLATES_V1.find(template => template.id === "flight-checkpoint");
  assert.ok(flight);
  const choices = mountChoices(layout, flight.pack);
  assert.deepEqual(choices.entries.map(anchor => anchor.id), ["airport"]);
  assert.equal(choices.slots[0]?.id, "gates");
  assert.deepEqual(choices.slots[0]?.anchors.map(anchor => anchor.id), ["gate"]);
  assert.equal(readMountBindings("null"), null);
});

// PR13 §7 绑定诊断（画布可读、语义化）：missing/能力不足/无候选/健康四类。
test("mount slot diagnostics stay semantic and canvas readable", () => {
  const layout: CityLayoutV1 = {
    schemaVersion: 1, id: "demo", coordinateSystem: "city-local-m-v1",
    anchors: [
      { id: "street", kind: "spawn", capabilities: ["drive"], geometryRef: "street" },
      { id: "corner", kind: "zone", capabilities: ["drive"], geometryRef: "corner" },
      { id: "corner2", kind: "zone", capabilities: ["drive"], geometryRef: "corner2" },
      { id: "gate", kind: "zone", capabilities: ["fly"], geometryRef: "gate" },
    ],
  };
  const game = {
    schemaVersion: 1, id: "demo.race", rulesVersion: 1,
    slots: { points: { kind: "zone", min: 2, max: 8, requires: ["drive"] } },
    rules: { counters: {}, nodes: [] },
  } as const;
  // 健康绑定：无诊断。
  assert.deepEqual(mountSlotDiagnostics(layout, game, { points: ["corner", "corner2"] }), []);
  // 目标被删：binding_target_missing，点位 id 只作引用（targetId），消息可读。
  const missing = mountSlotDiagnostics(layout, game, { points: ["corner", "gone:1"] })
    .find(item => item.code === "binding_target_missing");
  assert.equal(missing?.targetId, "gone:1");
  assert.match(missing?.message ?? "", /检查点/);
  assert.match(missing?.message ?? "", /gone:1/);
  // 能力不满足：binding_capability_unmet 指到具体点位。
  const capability = mountSlotDiagnostics(layout, game, { points: ["gate"] })
    .find(item => item.code === "binding_capability_unmet");
  assert.equal(capability?.targetId, "gate");
  assert.match(capability?.message ?? "", /drive/);
  // 候选为 0：slot_unfillable（route 类锚点在场景里一个都没有）。
  const drivingOnly = { ...game, slots: { points: { kind: "route", min: 1, max: 4, requires: ["drive"] } } };
  const unfillable = mountSlotDiagnostics(layout, drivingOnly, { points: [] })
    .find(item => item.code === "slot_unfillable");
  assert.equal(unfillable?.severity, "error");
  assert.match(unfillable?.message ?? "", /0 个候选/);
  // 候选不足 min：slot_underfilled（zone 需要 3 个，场景里只有 2 个 drive zone）。
  const greedy = { ...game, slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } } };
  const underfilled = mountSlotDiagnostics(layout, greedy, { points: [] })
    .find(item => item.code === "slot_underfilled");
  assert.match(underfilled?.message ?? "", /少于所需的 3 个/);
  // 尚未选点（bindings=null）也保留候选可用性提示；坏 JSON 由调用方另行提示。
  assert.ok(mountSlotDiagnostics(layout, greedy, null).some(item => item.code === "slot_underfilled"));
});
