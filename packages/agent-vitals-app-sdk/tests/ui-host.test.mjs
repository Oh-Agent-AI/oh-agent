import assert from "node:assert/strict";
import test from "node:test";

test("independent Preview wraps calls in the Tauri request envelope", async () => {
  const calls = [];
  globalThis.window = {
    parent: null,
    __AV_CODE_PREVIEW_ID__: "preview-ipc-test",
    __TAURI__: { core: { invoke: async (command, args) => { calls.push({ command, args }); return { ok: true }; } } },
  };
  const { invokeHost } = await import("../src/ui-host.ts");
  await invokeHost("plugin_request", { request: { version: 1, requestId: "request-1" } });
  assert.deepEqual(calls, [{
    command: "code_game_preview_request",
    args: { request: { previewId: "preview-ipc-test", command: "plugin_request", args: { request: { version: 1, requestId: "request-1" } } } },
  }]);
  delete globalThis.window;
});
