import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deploymentGatewayFixture } from "./remote-deployment-gateway-fixture.ts";

test("Rust deployment gateway fixture matches actual session output", () => {
  const path = new URL("../../../desktop/src-tauri/tests/remote_deployment_gateway_fixture.json", import.meta.url);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), deploymentGatewayFixture());
});
