#!/usr/bin/env node
// 断言 codex_session.html 模板里 sv-findings-fold 折叠逻辑在
// 「结构缺口 / 会话缺口 / 全覆盖」三类输入下的形状。
//
// 为什么是 node / 为什么接进自动化：同 verify-codex-session-timeline.mjs——
// 模板内联 JS 在 Python/Rust 里再实现一遍就是第二份拷贝，必然漂移；verify
// 脚本存在但没人跑 = 不存在。由 tests/test_codex_session_template.py 调 node
// 执行（本地 unittest 与 CI python job 都跑它）。
//
// 钉的 bug（2026-08-30）：Finding 队列把 10 个零覆盖信号一视同仁列成线索，
// 其中 5 个是执行环境线格式根本不提供的维度（结构缺口），任何会话都为零——KPI
// 分母 19 是永远到不了的满分；模板文案还残留「Codex 无 SV 行为检测器」的过时
// 结论（populate 后 SV601-603/610/611-613/614c 已能在 Codex 上跑）。修复：
// coverage 条目带 available 标记（Python/Rust 锁步），折叠只把「available 且
// 零」当会话线索，结构缺口折叠成一行静态说明，空态重新可达。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(
  join(here, '..', 'assets', 'templates', 'codex_session.html'),
  'utf8',
);

// 抽取 >>> sv-findings-fold / <<< sv-findings-fold 之间的纯函数源码，包成函数
// 表达式求值（末尾 () 立即调用解包，同 timeline verify 的教训）。函数体只依赖
// 入参（covKeys/unacc/esc），无 DOM、无闭包。
const m = tpl.match(/\/\/ >>> sv-findings-fold\n([\s\S]*?)\n\s*\/\/ <<< sv-findings-fold/);
if (!m) throw new Error('找不到 sv-findings-fold 标记块');
const svFindingsFold = new Function('covKeys', 'unacc', 'esc', 'return (' + m[1] + ');')();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  ok  ' + msg); }
  else { failed++; console.error('FAIL  ' + msg); }
};

// 结构缺口清单必须与 Python `_UNAVAILABLE_SIGNALS` / Rust `is_unavailable`
// 同源——这里只是文档性重复，锁步由代码两侧的测试钉（模板读 available 键，
// 不持有清单本身）。
const UNAVAIL = ['StepBoundaries', 'SandboxPolicy', 'NetworkAccess', 'UserCorrections'];
const entry = (total, available) => ({ measured: total, derived: 0, lossy: 0, unmetered: 0, available });

console.log('# sv-findings-fold（结构缺口 / 会话缺口 / 全覆盖）');

// 真实会话 01a029cb 形状（2026-08-30 实测）：10 个有覆盖（含 UserPrompts=15、
// QuotaConsumption=1）+ 5 个会话缺口（ApprovalDecisions/Compaction/
// SubagentSpawns/Hooks/FileMutations）+ 4 个结构缺口 → KPI 11/16（20 - 4）。
const covered = ['ToolCalls', 'ToolResults', 'TurnBoundaries', 'Usage', 'UsageAggregate',
  'ContextWindow', 'ApprovalPolicy', 'SandboxModes', 'SkillInvocations', 'UserPrompts',
  'QuotaConsumption'];
const gaps = ['ApprovalDecisions', 'Compaction', 'SubagentSpawns', 'Hooks', 'FileMutations'];
const covKeys = {};
covered.forEach((s) => { covKeys[s] = entry(s === 'UserPrompts' ? 15 : 1, true); });
gaps.forEach((s) => { covKeys[s] = entry(0, true); });
UNAVAIL.forEach((s) => { covKeys[s] = entry(0, false); });

const sum = svFindingsFold(covKeys, [{ type: 'compaction', count: 1 }], esc);
ok(sum.availCount === 16, 'availCount=16（20 - 4 结构缺口）');
ok(sum.availHit === 11, 'availHit=11（UserPrompts 已翻 measured、QuotaConsumption 计 1）');
ok(sum.gapCount === 5, 'gapCount=5（会话缺口，不含结构缺口）');
ok(sum.leads.length === 5 && sum.leads.every((s) => gaps.includes(s)),
  'leads 只含会话缺口：' + sum.leads.join(','));
ok(sum.unavail.length === 4 && sum.unavail.every((s) => UNAVAIL.includes(s)),
  'unavail 只含结构缺口：' + sum.unavail.join(','));
ok(sum.note.includes('1 条残差') && sum.note.includes('5 条会话缺口'), 'note 带残差 + 会话缺口计数');
ok(sum.struct.includes('StepBoundaries') && sum.struct.includes('UserCorrections'),
  '结构缺口折叠进 struct 一行说明');

// 全覆盖 + 无残差 → 0 线索：空态重新可达（此前 19 分母让 Codex 永远到不了）。
const full = {};
covered.concat(gaps).forEach((s) => { full[s] = entry(1, true); });
UNAVAIL.forEach((s) => { full[s] = entry(0, false); });
const empty = svFindingsFold(full, [], esc);
ok(empty.availHit === 16 && empty.gapCount === 0 && empty.leads.length === 0,
  '全覆盖 → 0 线索（空态可达）');
ok(empty.note === '无残差 · 0 条会话缺口', '全覆盖 note 无残差');

// 无结构缺口的输入 → struct 为空串（模板拼接不受影响）。
const noUnavail = {};
covered.concat(gaps).forEach((s) => { noUnavail[s] = entry(1, true); });
ok(svFindingsFold(noUnavail, [], esc).struct === '', '无结构缺口 → struct 为空串');

// 调用点必须经过纯函数——防止绕开标记块手写折叠（绕过即上述断言全部空转）。
ok(tpl.includes('var covSum = svFindingsFold(covKeys, unacc, esc);'),
  '模板调用点走 svFindingsFold()，不旁路');
// 过时文案必须已经删除（populate 后 Codex 有 SV 行为检测器）。
ok(!tpl.includes('Codex 无 SV 行为检测器'), '过时文案「Codex 无 SV 行为检测器」已删除');
// Phase 0：KPI 的「异常」只读真实 audit finding；coverage 留在证据质量表，
// 不再把一个永远非零的覆盖比例称为异常。
ok(tpl.includes("label: '审计异常'") && tpl.includes('auditSummary.findings_total'),
  'KPI 异常只读 audit finding 数');
ok(tpl.includes('var auditFindings = AUDIT.findings || [];'),
  'Finding 队列消费 audit.findings');

if (failed) { console.error('\n' + failed + ' 项断言失败'); process.exit(1); }
console.log('\n通过。');
