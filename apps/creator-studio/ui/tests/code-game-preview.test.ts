import test from "node:test";
import assert from "node:assert/strict";
import { boundCodePreviewRequest, canStopCodePreview, clearCodePreviewId, isTerminalCodePreviewStatus, isValidCodePreviewId, parseCodeBuilds, parseCodePreviewCreated, parseCodePreviewStatus, parseCodeStoryEvidence, readCodePreviewId, rememberCodePreviewId } from "../src/codeGamePreview";

test("Studio accepts bounded immutable build rows", () => {
  const rows = parseCodeBuilds({ builds: [{ buildId: "a".repeat(64), gameId: "community.demo", gameVersion: "1.0.0", byteLength: 42, createdAtMs: 1 }] });
  assert.equal(rows[0]?.gameId, "community.demo");
  assert.throws(() => parseCodeBuilds({ builds: [{ buildId: "../private", gameId: "bad" }] }), /creator_code_builds_invalid/);
  assert.throws(() => parseCodeBuilds({}), /creator_code_builds_invalid/);
});

test("Studio Preview status is projected to known telemetry and stop states", () => {
  const running = parseCodePreviewStatus({ available: true, status: "running", gameId: "community.demo", previewId: "preview-1", buildId: "b".repeat(64), runId: "run-1", tick: 12, entities: 1 });
  assert.equal(running.tick, 12);
  assert.equal(canStopCodePreview(running), true);
  const finished = parseCodePreviewStatus({ available: true, status: "finished", outcome: "success", tick: 120, entities: 0 });
  assert.equal(finished.outcome, "success");
  assert.equal(canStopCodePreview(finished), false);
  assert.throws(() => parseCodePreviewStatus(null), /creator_code_preview_status_invalid/);
});

test("Studio Story evidence is a whitelist projection, not a state copy", () => {
  const evidence = parseCodeStoryEvidence({ available: true, storyRevision: "sha256:story", state: { affection: 2, privateNote: "not projected" },
    rules: [{ ruleId: "date-saturday", nextDueUtcMs: 1_000, status: "scheduled" }],
    dialogue: [{ eventId: "event-1", text: "See you Saturday.", createdAtMs: 1 }] });
  assert.equal(evidence.affection, 2);
  assert.equal(evidence.rules[0]?.ruleId, "date-saturday");
  assert.equal(evidence.dialogue[0]?.text, "See you Saturday.");
  assert.equal("privateNote" in evidence, false);
  assert.equal(parseCodeStoryEvidence({ available: false }).rules.length, 0);
  assert.throws(() => parseCodeStoryEvidence({ available: true, dialogue: [{ eventId: "bad", text: "" }] }), /creator_code_story_invalid/);
});

// 预览身份隔离（PR 01）：workspace（面板选中的 build）只绑定自己 start 出来的 previewId，
// 轮询与停止共用同一身份来源，绝不回退 legacy 全局投影。存储 stub 模式同 workspace-layout.test.ts。
const withLocalStorage = (values = new Map<string, string>()) => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } } });
  return { values, restore: () => Object.assign(globalThis, { window: previous }) };
};

test("Studio persists the previewId returned at start and poll/stop payloads carry it", () => {
  const storage = withLocalStorage();
  try {
    const buildId = "b".repeat(64);
    const created = parseCodePreviewCreated({ requestId: `preview-request-${"1".repeat(32)}`, previewId: `preview-${"a".repeat(32)}`, buildId, seed: 7, status: "queued" });
    assert.equal(created.previewId, `preview-${"a".repeat(32)}`);
    rememberCodePreviewId(buildId, created.previewId);
    // refreshStatus 与 stop 都用 boundCodePreviewRequest 构造载荷：状态请求必须带存储的 previewId
    assert.deepEqual(boundCodePreviewRequest(buildId), { previewId: created.previewId });
    assert.equal(readCodePreviewId(buildId), created.previewId);
    // 关闭并重开 Studio（组件状态清零、仅剩 localStorage）后绑定仍在
    storage.restore();
    const reopened = withLocalStorage(storage.values);
    try { assert.deepEqual(boundCodePreviewRequest(buildId), { previewId: created.previewId }); }
    finally { reopened.restore(); }
    // stop 成功后面板清掉绑定：此后不再发任何状态请求（呈现未运行）
    clearCodePreviewId(buildId);
    assert.equal(boundCodePreviewRequest(buildId), null);
  } finally { storage.restore(); }
});

test("No bound previewId means no status request at all; legacy projection stays parse-compatible", () => {
  const storage = withLocalStorage();
  try {
    // 未绑定 → 载荷为 null，UI 呈现"未在运行"，不回退 legacy 全局投影
    assert.equal(boundCodePreviewRequest("c".repeat(64)), null);
    assert.equal(readCodePreviewId(""), null);
    // 兼容面：宿主仍向旧调用方返回带 legacyScope 标记的全局投影，解析器保持兼容，
    // 但 Studio 自己的请求载荷永远携带 previewId。
    const legacy = parseCodePreviewStatus({ available: true, legacyScope: true, status: "running", gameId: "community.demo",
      previewId: `preview-${"e".repeat(32)}`, buildId: "f".repeat(64), runId: "run-1", tick: 3, entities: 1 });
    assert.equal(legacy.status, "running");
    assert.equal(canStopCodePreview(legacy), true);
  } finally { storage.restore(); }
});

test("Two workspace scopes never cross-contaminate their preview bindings", () => {
  const storage = withLocalStorage();
  try {
    const buildA = "1".repeat(64);
    const buildB = "2".repeat(64);
    rememberCodePreviewId(buildA, `preview-${"a".repeat(32)}`);
    rememberCodePreviewId(buildB, `preview-${"b".repeat(32)}`);
    assert.deepEqual(boundCodePreviewRequest(buildA), { previewId: `preview-${"a".repeat(32)}` });
    assert.deepEqual(boundCodePreviewRequest(buildB), { previewId: `preview-${"b".repeat(32)}` });
    clearCodePreviewId(buildA);
    assert.equal(boundCodePreviewRequest(buildA), null);
    assert.equal(readCodePreviewId(buildB), `preview-${"b".repeat(32)}`);
  } finally { storage.restore(); }
});

test("Only host-confirmed terminal states unbind; pre-start unavailable does not", () => {
  const storage = withLocalStorage();
  try {
    const buildId = "d".repeat(64);
    const previewId = `preview-${"c".repeat(32)}`;
    rememberCodePreviewId(buildId, previewId);
    // 创建后、游戏首次上报前：宿主按 ID 查询返回 available:false，不是终态 → 不得解绑
    const queued = parseCodePreviewStatus({ available: false, status: "unavailable", previewId });
    assert.equal(isTerminalCodePreviewStatus(queued), false);
    assert.equal(readCodePreviewId(buildId), previewId);
    assert.equal(isTerminalCodePreviewStatus(parseCodePreviewStatus({ available: true, status: "running", previewId, runId: "run-1" })), false);
    assert.equal(isTerminalCodePreviewStatus(parseCodePreviewStatus({ available: true, status: "finished", outcome: "success", previewId })), true);
    assert.equal(isTerminalCodePreviewStatus(parseCodePreviewStatus({ available: true, status: "error", outcome: "failure", previewId })), true);
  } finally { storage.restore(); }
});

test("Storage and create responses are untrusted input: bad ids never bind", () => {
  const storage = withLocalStorage();
  try {
    const buildId = "a".repeat(64);
    rememberCodePreviewId(buildId, "../escape");
    assert.equal(readCodePreviewId(buildId), null);
    rememberCodePreviewId("", `preview-${"a".repeat(32)}`);
    assert.equal(readCodePreviewId(""), null);
    rememberCodePreviewId(buildId, `preview-${"a".repeat(32)}`);
    storage.values.set(`oh-agent.studio.code-preview.v1:${buildId}`, "preview-with space");
    assert.equal(readCodePreviewId(buildId), null);
    assert.equal(isValidCodePreviewId(`preview-${"0123456789abcdef".repeat(2)}`), true);
    assert.equal(isValidCodePreviewId("-leading-punct"), false);
    assert.throws(() => parseCodePreviewCreated({ requestId: "r", buildId, seed: 7 }), /creator_code_preview_created_invalid/);
    assert.throws(() => parseCodePreviewCreated({ requestId: "r", previewId: "../escape", buildId, seed: 7 }), /creator_code_preview_created_invalid/);
    assert.throws(() => parseCodePreviewCreated({ requestId: "r", previewId: `preview-${"a".repeat(32)}`, buildId: "zz", seed: 7 }), /creator_code_preview_created_invalid/);
    assert.throws(() => parseCodePreviewCreated(null), /creator_code_preview_created_invalid/);
  } finally { storage.restore(); }
});
