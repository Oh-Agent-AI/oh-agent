import test from "node:test";
import assert from "node:assert/strict";
import { copyTextWithTimeout } from "../src/features/agent/clipboardCopy.ts";

test("clipboard copy reports success only after the browser write resolves", async () => {
  let resolved = false;
  await copyTextWithTimeout(async () => { resolved = true; }, 100);
  assert.equal(resolved, true);
});

test("clipboard copy stops waiting when browser permission never settles", async () => {
  await assert.rejects(copyTextWithTimeout(() => new Promise<void>(() => {}), 5), /clipboard_copy_timeout/);
});

test("clipboard copy preserves browser permission failures", async () => {
  await assert.rejects(copyTextWithTimeout(() => Promise.reject(new Error("denied")), 100), /denied/);
});
