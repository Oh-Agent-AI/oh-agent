#!/usr/bin/env node
// Static contract for the Usage page's two independent projections. This is
// intentionally small: the bridge parser is covered by the Overview/Usage
// contract; this guard prevents a UI refactor from silently rejoining an old
// source window to the newly selected calendar month.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/features/usage/UsagePage.tsx"), "utf8");
const translations = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/lib/i18n.ts"), "utf8");

for (const marker of [
  "const sourceForDisplayedMonth = source?.month === displayedMonth ? source : null;",
  "const sourceForPanel = source;",
  '"usage.sourceUnaligned"',
  'message("usage.window", language, { month: monthTitle(sourceForPanel.month) })',
  '"usage.lastObservedLabel"',
  'sourceForPanel.last_observed_at ?? message("usage.noTimeEvidence", language)',
  '"usage.unresolved"',
  '"usage.unresolvedYes"',
  '"usage.sourceUnavailable"',
]) assert.ok(page.includes(marker), `missing Usage window marker: ${marker}`);

for (const marker of ["当前月份来源摘要不可用或尚未对齐", "窗口：{month}", "最后观测", "不计为账单实付", "日历与来源面板独立读取"]) {
  assert.ok(translations.includes(marker), `missing Chinese Usage translation: ${marker}`);
}

assert.ok(page.includes("spendBasisLabel(sourceForDisplayedMonth.spend_by_basis)"));
assert.ok(page.includes('sourceForPanel.has_unresolved ? message("usage.unresolvedYes", language)'));
console.log("React Usage window contract: OK (matching summaries, explicit source window, evidence labels)");
