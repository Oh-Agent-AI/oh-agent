import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_TEMPLATES_V1, type CityLayoutV1 } from "@oh-agent/city-sdk";
import { mountChoices, readMountBindings } from "../src/features/project/mountEditorModel.ts";

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
