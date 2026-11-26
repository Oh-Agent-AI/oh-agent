/**
 * 锁步向量守卫（TS 权威面，E5 验收）：fixture（apps/desktop/src-tauri/
 * embedded_city_sdk/lockstep-vectors.json）是生成器在 Node/V8 下对**当前**适配器
 * import 链跑出的 invoke 输出。本测试在测试进程里对同一批向量重新执行 gate，逐字节
 * 比对——TS 行为一旦漂移（而 fixture 没有重新生成）立即失败；Rust 侧
 * （embedded_city_sdk.rs 的同名测试）则证明 QuickJS 路径对同一 fixture 同样逐字节
 * 一致。两面全绿才构成「同一输入、两个运行时、同诊断」的完整锁步证明。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citySdkGate } from "../src/embeddedGate";

const FIXTURE = new URL("../../../desktop/src-tauri/embedded_city_sdk/lockstep-vectors.json", import.meta.url);

test("embedded gate lockstep fixture matches the current TS behavior byte for byte", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    vectors: Array<{ id: string; entry: string; args: unknown; expected: string }>;
  };
  assert.ok(fixture.vectors.length >= 20, "the acceptance vector set must stay broad");
  for (const vector of fixture.vectors) {
    const actual = citySdkGate.invoke(vector.entry, JSON.stringify(vector.args));
    assert.equal(actual, vector.expected, `lockstep divergence on vector ${vector.id} — regenerate the fixture via its regenerate command`);
  }
});

test("gate registers the versioned bridge contract", () => {
  assert.equal(citySdkGate.version, 1);
  assert.equal(citySdkGate.engine, "quickjs");
  const unknown = citySdkGate.invoke("no.such.entry", "{}");
  assert.equal(JSON.parse(unknown).ok, false);
});
