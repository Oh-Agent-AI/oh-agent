import test from "node:test";
import assert from "node:assert/strict";
import { classifyExecutor, directorySummary, groupByBrand, toExecutorEntry } from "../src/features/agent/agentDirectory.ts";
import type { StudioExecutorStatus } from "../src/contracts/studioTask.ts";

const executor = (overrides: Partial<StudioExecutorStatus> & Pick<StudioExecutorStatus, "id" | "name">): StudioExecutorStatus =>
  ({ available: true, modes: [{ id: "restricted", restricted: true, label: "受限提案" }], ...overrides });

const usable = (id: string, name = id) => executor({ id, name });
const offline = (id: string, name: string, detail?: string) => executor({ id, name, available: false, ...(detail ? { detail } : {}) });
const noRestricted = (id: string, name: string) => executor({ id, name, modes: [{ id: "full-access", restricted: false, label: "完全访问" }] });

test("classification: available with restricted mode is usable; failures carry visible reasons", () => {
  assert.equal(classifyExecutor(usable("a")), "usable");
  assert.equal(classifyExecutor(offline("a", "Codex", "进程未运行")), "unavailable");
  assert.equal(classifyExecutor(noRestricted("a", "Codex")), "needs-setup");
  const entry = toExecutorEntry(offline("codex-1", "Codex", "进程未运行"));
  assert.equal(entry.reason, "进程未运行");
  assert.equal(toExecutorEntry(noRestricted("a", "Codex")).reason, "此 Agent 未提供受限提案模式");
  assert.equal(toExecutorEntry(usable("a")).reason, null);
  // detail 缺省时给诚实兜底文案，不猜原因。
  assert.equal(toExecutorEntry(offline("a", "Codex")).reason, "连接不可用");
});

test("brand dedupe: same-name connections collapse into one entry with usable first", () => {
  const groups = groupByBrand([
    offline("codex-cli", "Codex"),
    usable("codex-acp", "Codex"),
    usable("kimi", "Kimi Code"),
  ]);
  assert.equal(groups.length, 2);
  const codex = groups.find(group => group.brand === "Codex");
  assert.equal(codex?.entries.length, 2);
  assert.equal(codex?.entries[0].id, "codex-acp");
  assert.equal(codex?.usableCount, 1);
  // 可用品牌排在待连接品牌之前。
  assert.equal(groups[0].brand, "Codex");
  assert.equal(groups[1].brand, "Kimi Code");
});

test("directory summary counts usable and pending connections", () => {
  assert.equal(directorySummary(groupByBrand([usable("a"), usable("b")])), "2 条可用于创作");
  assert.equal(directorySummary(groupByBrand([offline("a", "A")])), "1 条待连接");
  assert.equal(directorySummary(groupByBrand([usable("a"), offline("b", "B")])), "1 条可用于创作 · 1 条待连接");
  assert.equal(directorySummary(groupByBrand([])), "0 条可用于创作");
});
