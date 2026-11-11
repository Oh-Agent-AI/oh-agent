import test from "node:test";
import assert from "node:assert/strict";
import { remoteRoute } from "../src/remote/remoteRoute.ts";

test("only the v1.5 capability opens the phone battle", () => {
  assert.equal(remoteRoute("mecha:v4"), "sequential");
  for (const capability of ["mecha:v1", "mecha:v2", "mecha:v3", null] as const) assert.equal(remoteRoute(capability), "retired");
});
