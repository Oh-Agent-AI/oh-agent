#!/usr/bin/env node
// E9 Creator MCP tool-face evals — deterministic grader.
//
// Pattern source: T3 Code evals/mcp-tool-use (t3code @ 70abb6c0) via
// docs/STUDIO_AGENT_FIRST_T3CODE_COMPARISON_2026_11_15.md (dimension D9): every
// case replays one real incident; this grader checks the replayed work record
// against mechanically verifiable rubric criteria. No model calls, no host
// runs, no randomness — model-driven replay is a later extension (see README).
//
// Usage:
//   node evals/creator/run.mjs --list
//   node evals/creator/run.mjs --case <id> --transcript <work-record.json> [--json]
//   node evals/creator/run.mjs --self-test
//
// Exit codes: 0 = pass, 1 = rubric failure (or self-test failure), 2 = usage
// or input error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases");

// ---------------------------------------------------------------------------
// Transcript semantics
// ---------------------------------------------------------------------------

// Rubric item types understood by the grader. The list is closed: a case file
// referencing any other type is a schema violation (exit code 2).
const RUBRIC_TYPES = new Set([
  "no-claim",
  "verified-claim",
  "forbidden-write",
  "writes-within",
  "required-write",
  "required-call",
  "required-call-before-write",
  "write-summary-must-contain",
  "write-summary-must-not-contain",
  "forbidden-write-unless",
]);

// Tools that mutate files. Exact names plus any name starting with one of the
// prefixes (so "edit_file"/"apply_patch"-style tool names are covered).
const WRITE_TOOL_EXACT = new Set([
  "write",
  "edit",
  "patch",
  "apply_patch",
  "create",
  "replace",
  "save",
]);
const WRITE_TOOL_PREFIXES = ["write", "edit", "patch", "apply", "create", "replace", "save"];

// Entries that can carry a completion/status claim. Claims are detected by
// rubric literals, but only inside these tools — mid-flight tool output is not
// a claim. Documented in README.md ("claim entries").
const CLAIM_TOOL_PATTERN =
  /(report|claim|verdict|final|summary|respond|response|message|handoff|say|echo)/i;

function isWriteEntry(entry) {
  if (WRITE_TOOL_EXACT.has(entry.tool)) return true;
  const tool = entry.tool.toLowerCase();
  return WRITE_TOOL_PREFIXES.some((p) => tool.startsWith(p));
}

function isClaimEntry(entry) {
  return CLAIM_TOOL_PATTERN.test(entry.tool);
}

function containsLiteral(summary, literal) {
  return summary.toLowerCase().includes(literal.toLowerCase());
}

// ---------------------------------------------------------------------------
// Glob matching (case-sensitive; "**" crosses "/", "*" stays within a segment)
// ---------------------------------------------------------------------------

const globCache = new Map();

function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        re += "[\\s\\S]*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function globMatch(pattern, value) {
  let re = globCache.get(pattern);
  if (re === undefined) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(value);
}

// ---------------------------------------------------------------------------
// Conditions (shared entry-match shape used by rubric items)
// ---------------------------------------------------------------------------

const CONDITION_FIELDS = [
  "tool",
  "toolGlob",
  "pathGlob",
  "isWrite",
  "summaryContainsAny",
  "summaryContainsAll",
];

function isConditionObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return CONDITION_FIELDS.some((f) => value[f] !== undefined);
}

function validateCondition(cond, where) {
  if (!isConditionObject(cond)) {
    throw new Error(
      `${where}: condition must be an object with at least one of ${CONDITION_FIELDS.join(", ")}`,
    );
  }
  for (const field of ["tool", "toolGlob", "pathGlob"]) {
    if (cond[field] !== undefined && (typeof cond[field] !== "string" || cond[field] === "")) {
      throw new Error(`${where}: condition.${field} must be a non-empty string`);
    }
  }
  if (cond.isWrite !== undefined && typeof cond.isWrite !== "boolean") {
    throw new Error(`${where}: condition.isWrite must be a boolean`);
  }
  for (const field of ["summaryContainsAny", "summaryContainsAll"]) {
    if (cond[field] !== undefined) {
      if (
        !Array.isArray(cond[field]) ||
        cond[field].length === 0 ||
        !cond[field].every((x) => typeof x === "string" && x.length > 0)
      ) {
        throw new Error(`${where}: condition.${field} must be a non-empty array of strings`);
      }
    }
  }
}

function matchesCondition(cond, entry) {
  if (cond.tool !== undefined && entry.tool !== cond.tool) return false;
  if (cond.toolGlob !== undefined && !globMatch(cond.toolGlob, entry.tool)) return false;
  if (
    cond.pathGlob !== undefined &&
    (typeof entry.path !== "string" || !globMatch(cond.pathGlob, entry.path))
  ) {
    return false;
  }
  if (cond.isWrite === true && !isWriteEntry(entry)) return false;
  if (
    cond.summaryContainsAny !== undefined &&
    !cond.summaryContainsAny.some((lit) => containsLiteral(entry.summary, lit))
  ) {
    return false;
  }
  if (
    cond.summaryContainsAll !== undefined &&
    !cond.summaryContainsAll.every((lit) => containsLiteral(entry.summary, lit))
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rubric schema validation
// ---------------------------------------------------------------------------

function validateStringArray(value, where) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((x) => typeof x === "string" && x.length > 0)
  ) {
    throw new Error(`${where}: must be a non-empty array of strings`);
  }
}

function validateRubricItem(item, index) {
  const where = `rubric item #${index + 1}${item.id ? ` (${item.id})` : ""}`;
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`${where}: must be an object`);
  }
  if (!RUBRIC_TYPES.has(item.type)) {
    throw new Error(
      `${where}: unknown type "${item.type}"; expected one of ${[...RUBRIC_TYPES].join(", ")}`,
    );
  }
  if (item.id !== undefined && (typeof item.id !== "string" || item.id === "")) {
    throw new Error(`${where}: id must be a non-empty string`);
  }
  if (item.note !== undefined && typeof item.note !== "string") {
    throw new Error(`${where}: note must be a string`);
  }
  const t = item.type;
  if (t === "verified-claim") {
    validateStringArray(item.claimContainsAny, `${where}: claimContainsAny`);
    if (!Array.isArray(item.evidenceAll) || item.evidenceAll.length === 0) {
      throw new Error(`${where}: evidenceAll must be a non-empty array of conditions`);
    }
    item.evidenceAll.forEach((c, i) => validateCondition(c, `${where}: evidenceAll[${i}]`));
  }
  if (t === "no-claim") validateStringArray(item.claimContainsAny, `${where}: claimContainsAny`);
  if (
    t === "forbidden-write" ||
    t === "required-write" ||
    t === "write-summary-must-contain" ||
    t === "write-summary-must-not-contain" ||
    t === "forbidden-write-unless"
  ) {
    validateStringArray(item.paths, `${where}: paths`);
  }
  if (t === "forbidden-write" && item.remediableBy !== undefined) {
    validateCondition(item.remediableBy, `${where}: remediableBy`);
  }
  if (t === "writes-within") {
    validateStringArray(item.allow, `${where}: allow`);
    if (item.remediableBy !== undefined) {
      validateCondition(item.remediableBy, `${where}: remediableBy`);
    }
  }
  if (t === "required-write") {
    if (
      item.minCount !== undefined &&
      (!Number.isInteger(item.minCount) || item.minCount < 1)
    ) {
      throw new Error(`${where}: minCount must be a positive integer`);
    }
    if (
      item.summaryContainsAny !== undefined &&
      (!Array.isArray(item.summaryContainsAny) ||
        item.summaryContainsAny.length === 0 ||
        !item.summaryContainsAny.every((x) => typeof x === "string"))
    ) {
      throw new Error(`${where}: summaryContainsAny must be a non-empty array of strings`);
    }
  }
  if (t === "write-summary-must-contain") {
    validateStringArray(item.anyOf, `${where}: anyOf`);
  }
  if (t === "write-summary-must-not-contain") {
    validateStringArray(item.literals, `${where}: literals`);
  }
  if (t === "forbidden-write-unless") {
    if (!Array.isArray(item.unlessAll) || item.unlessAll.length === 0) {
      throw new Error(`${where}: unlessAll must be a non-empty array of conditions`);
    }
    item.unlessAll.forEach((c, i) => validateCondition(c, `${where}: unlessAll[${i}]`));
  }
  if (t === "required-call" || t === "required-call-before-write") {
    if (!isConditionObject(item)) {
      throw new Error(
        `${where}: needs at least one match field (${CONDITION_FIELDS.join(", ")})`,
      );
    }
    validateCondition(item, where);
    if (
      t === "required-call" &&
      item.minCount !== undefined &&
      (!Number.isInteger(item.minCount) || item.minCount < 1)
    ) {
      throw new Error(`${where}: minCount must be a positive integer`);
    }
  }
}

function validateRubric(rubric) {
  if (!Array.isArray(rubric) || rubric.length === 0) {
    throw new Error("rubric must be a non-empty JSON array");
  }
  rubric.forEach((item, i) => validateRubricItem(item, i));
  const seen = new Set();
  for (const item of rubric) {
    if (item.id !== undefined) {
      if (seen.has(item.id)) throw new Error(`duplicate rubric item id "${item.id}"`);
      seen.add(item.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Case file parsing
// ---------------------------------------------------------------------------

function parseCaseMarkdown(text, filePath) {
  const idMatch = text.match(/^-\s+id:\s*(\S+)\s*$/m);
  if (!idMatch) {
    throw new Error(`${filePath}: missing "- id: <case-id>" header line`);
  }
  const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
  const lines = text.split(/\r?\n/);
  let rubric = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "```rubric") {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim().startsWith("```")) break;
        body.push(lines[j]);
      }
      if (j === lines.length) {
        throw new Error(`${filePath}: "\`\`\`rubric" block is not closed`);
      }
      try {
        rubric = JSON.parse(body.join("\n"));
      } catch (err) {
        throw new Error(`${filePath}: rubric block is not valid JSON: ${err.message}`);
      }
      break;
    }
  }
  if (rubric === null) {
    throw new Error(`${filePath}: no "\`\`\`rubric" fenced block found`);
  }
  validateRubric(rubric);
  return { id: idMatch[1], title: titleMatch ? titleMatch[1] : idMatch[1], rubric };
}

function loadCases() {
  const files = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const cases = [];
  for (const file of files) {
    const filePath = path.join(CASES_DIR, file);
    const parsed = parseCaseMarkdown(fs.readFileSync(filePath, "utf8"), filePath);
    cases.push({ ...parsed, file });
  }
  return cases;
}

function loadCase(id, cases) {
  const found = cases.find((c) => c.id === id);
  if (!found) {
    const known = cases.map((c) => c.id).join(", ");
    throw new Error(`unknown case "${id}"; known cases: ${known || "(none)"}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Transcript loading
// ---------------------------------------------------------------------------

function validateTranscript(entries, source) {
  if (!Array.isArray(entries)) {
    throw new Error(`${source}: transcript must be a JSON array of {tool, path?, summary}`);
  }
  entries.forEach((entry, i) => {
    const where = `${source}: transcript entry #${i + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where}: must be an object`);
    }
    if (typeof entry.tool !== "string" || entry.tool.length === 0) {
      throw new Error(`${where}: "tool" must be a non-empty string`);
    }
    if (typeof entry.summary !== "string") {
      throw new Error(`${where}: "summary" must be a string`);
    }
    if (entry.path !== undefined && entry.path !== null && typeof entry.path !== "string") {
      throw new Error(`${where}: "path" must be a string or null`);
    }
  });
}

function loadTranscriptFile(filePath, caseFlag) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read transcript ${filePath}: ${err.message}`);
  }
  let caseId = caseFlag;
  let entries;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "object" && raw !== null) {
    entries = raw.transcript;
    if (caseId === undefined && typeof raw.case === "string") caseId = raw.case;
  } else {
    throw new Error(`${filePath}: expected {case, transcript} or a bare array`);
  }
  validateTranscript(entries, filePath);
  return { caseId, entries };
}

// ---------------------------------------------------------------------------
// Rubric evaluation (deterministic; rubric order defines output order)
// ---------------------------------------------------------------------------

function entryRef(index) {
  return `#${index + 1}`;
}

function pathBase(p) {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function evalNoClaim(item, entries) {
  const hits = [];
  entries.forEach((entry, i) => {
    if (isClaimEntry(entry) && item.claimContainsAny.some((lit) => containsLiteral(entry.summary, lit))) {
      hits.push(i);
    }
  });
  if (hits.length === 0) {
    return { pass: true, detail: "no matching claim entry" };
  }
  return {
    pass: false,
    detail: `forbidden claim at entry ${hits.map(entryRef).join(", ")}`,
  };
}

function evalVerifiedClaim(item, entries) {
  const offenders = [];
  entries.forEach((entry, i) => {
    if (!isClaimEntry(entry)) return;
    if (!item.claimContainsAny.some((lit) => containsLiteral(entry.summary, lit))) return;
    const earlier = entries.slice(0, i);
    const missing = [];
    item.evidenceAll.forEach((cond, ci) => {
      if (!earlier.some((e) => matchesCondition(cond, e))) missing.push(ci + 1);
    });
    if (missing.length > 0) {
      offenders.push(`${entryRef(i)} (missing evidence condition ${missing.join(", ")})`);
    }
  });
  if (offenders.length === 0) {
    return { pass: true, detail: "every matching claim is backed by earlier evidence" };
  }
  return { pass: false, detail: `unbacked claim at entry ${offenders.join(", ")}` };
}

// Shared forgiveness rule for `remediableBy` on write-restriction items: the
// offending write is forgiven when a later entry matches the remediation
// condition and its summary mentions the same path (full path or basename).
function isRemediated(item, entry, index, entries) {
  if (!item.remediableBy) return false;
  const base = pathBase(entry.path);
  return entries.some(
    (e, j) =>
      j > index &&
      matchesCondition(item.remediableBy, e) &&
      (e.summary.includes(entry.path) || (base.length >= 3 && e.summary.includes(base))),
  );
}

function evalForbiddenWrite(item, entries) {
  const offenses = [];
  entries.forEach((entry, i) => {
    if (!isWriteEntry(entry) || typeof entry.path !== "string") return;
    if (!item.paths.some((g) => globMatch(g, entry.path))) return;
    if (isRemediated(item, entry, i, entries)) return;
    offenses.push(entryRef(i));
  });
  if (offenses.length === 0) {
    return { pass: true, detail: "no matching write entry" };
  }
  return {
    pass: false,
    detail: `write to forbidden path${offenses.length === 1 ? "" : "s"} at entry ${offenses.join(", ")}`,
  };
}

function evalWritesWithin(item, entries) {
  const violations = [];
  entries.forEach((entry, i) => {
    if (!isWriteEntry(entry)) return;
    if (typeof entry.path !== "string") {
      violations.push(`${entryRef(i)} (write without path)`);
      return;
    }
    if (!item.allow.some((g) => globMatch(g, entry.path))) {
      if (isRemediated(item, entry, i, entries)) return;
      violations.push(`${entryRef(i)} (${entry.path})`);
    }
  });
  if (violations.length === 0) {
    return { pass: true, detail: "all write entries inside the allowed set" };
  }
  return { pass: false, detail: `write outside allowed paths at entry ${violations.join(", ")}` };
}

function evalRequiredWrite(item, entries) {
  const minCount = item.minCount === undefined ? 1 : item.minCount;
  const matches = [];
  entries.forEach((entry, i) => {
    if (!isWriteEntry(entry) || typeof entry.path !== "string") return;
    if (!item.paths.some((g) => globMatch(g, entry.path))) return;
    if (
      item.summaryContainsAny !== undefined &&
      !item.summaryContainsAny.some((lit) => containsLiteral(entry.summary, lit))
    ) {
      return;
    }
    matches.push(entryRef(i));
  });
  if (matches.length >= minCount) {
    return { pass: true, detail: `${matches.length} matching write entr${matches.length === 1 ? "y" : "ies"}` };
  }
  return {
    pass: false,
    detail: `expected >=${minCount} matching write entries, found ${matches.length}`,
  };
}

function evalRequiredCall(item, entries) {
  const minCount = item.minCount === undefined ? 1 : item.minCount;
  const matches = [];
  entries.forEach((entry, i) => {
    if (matchesCondition(item, entry)) matches.push(entryRef(i));
  });
  if (matches.length >= minCount) {
    return { pass: true, detail: `${matches.length} matching entr${matches.length === 1 ? "y" : "ies"}` };
  }
  return {
    pass: false,
    detail: `expected >=${minCount} matching entries, found ${matches.length}`,
  };
}

function evalRequiredCallBeforeWrite(item, entries) {
  let firstWrite = -1;
  entries.forEach((entry, i) => {
    if (firstWrite === -1 && isWriteEntry(entry)) firstWrite = i;
  });
  if (firstWrite === -1) {
    return { pass: true, detail: "no write entries" };
  }
  const earlier = entries.slice(0, firstWrite);
  if (earlier.some((e) => matchesCondition(item, e))) {
    return { pass: true, detail: `verification precedes first write at entry ${entryRef(firstWrite)}` };
  }
  return {
    pass: false,
    detail: `first write at entry ${entryRef(firstWrite)} has no preceding verification entry`,
  };
}

function writeEntriesOnPaths(item, entries) {
  const out = [];
  entries.forEach((entry, i) => {
    if (!isWriteEntry(entry) || typeof entry.path !== "string") return;
    if (item.paths.some((g) => globMatch(g, entry.path))) out.push([i, entry]);
  });
  return out;
}

function evalWriteSummaryMustContain(item, entries) {
  const targets = writeEntriesOnPaths(item, entries);
  if (targets.length === 0) {
    return { pass: true, detail: "no write entries on the watched paths (vacuous)" };
  }
  const violations = targets
    .filter(([, e]) => !item.anyOf.some((lit) => containsLiteral(e.summary, lit)))
    .map(([i]) => entryRef(i));
  if (violations.length === 0) {
    return { pass: true, detail: `${targets.length} write entr${targets.length === 1 ? "y" : "ies"} all name an expected literal` };
  }
  return {
    pass: false,
    detail: `write entr${violations.length === 1 ? "y" : "ies"} ${violations.join(", ")} on watched paths name none of the expected literals`,
  };
}

function evalWriteSummaryMustNotContain(item, entries) {
  const targets = writeEntriesOnPaths(item, entries);
  const violations = [];
  for (const [i, e] of targets) {
    const hit = item.literals.filter((lit) => containsLiteral(e.summary, lit));
    if (hit.length > 0) violations.push(`${entryRef(i)} (${hit.join("; ")})`);
  }
  if (violations.length === 0) {
    return { pass: true, detail: "no forbidden literal in write entries on the watched paths" };
  }
  return { pass: false, detail: `forbidden literal at entry ${violations.join(", ")}` };
}

function evalForbiddenWriteUnless(item, entries) {
  const offenses = writeEntriesOnPaths(item, entries);
  if (offenses.length === 0) {
    return { pass: true, detail: "no write entry on the protected paths" };
  }
  const unmet = [];
  item.unlessAll.forEach((cond, ci) => {
    if (!entries.some((e) => matchesCondition(cond, e))) unmet.push(ci + 1);
  });
  if (unmet.length === 0) {
    return { pass: true, detail: `${offenses.length} write entr${offenses.length === 1 ? "y" : "ies"} on protected paths, all covered by unless evidence` };
  }
  return {
    pass: false,
    detail: `write on protected path at entry ${offenses.map(([i]) => entryRef(i)).join(", ")} without unless evidence (missing condition ${unmet.join(", ")})`,
  };
}

const EVALUATORS = {
  "no-claim": evalNoClaim,
  "verified-claim": evalVerifiedClaim,
  "forbidden-write": evalForbiddenWrite,
  "writes-within": evalWritesWithin,
  "required-write": evalRequiredWrite,
  "required-call": evalRequiredCall,
  "required-call-before-write": evalRequiredCallBeforeWrite,
  "write-summary-must-contain": evalWriteSummaryMustContain,
  "write-summary-must-not-contain": evalWriteSummaryMustNotContain,
  "forbidden-write-unless": evalForbiddenWriteUnless,
};

function grade(rubric, entries) {
  const items = rubric.map((item, idx) => {
    const evaluate = EVALUATORS[item.type];
    const outcome = evaluate(item, entries);
    return {
      index: idx + 1,
      id: item.id === undefined ? `item-${idx + 1}` : item.id,
      type: item.type,
      note: item.note,
      pass: outcome.pass === true,
      detail: outcome.detail,
    };
  });
  const failed = items.filter((r) => !r.pass);
  return { items, passed: failed.length === 0, failedIds: failed.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport(caseId, title, result, entryCount, asJson) {
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          case: caseId,
          title,
          entryCount,
          verdict: result.passed ? "PASS" : "FAIL",
          passed: result.items.filter((r) => r.pass).length,
          total: result.items.length,
          items: result.items.map((r) => ({
            id: r.id,
            type: r.type,
            pass: r.pass,
            detail: r.detail,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [];
  lines.push(`E9 creator evals — case: ${caseId}`);
  lines.push(`  ${title}`);
  lines.push(`  work-record entries: ${entryCount}`);
  for (const r of result.items) {
    const mark = r.pass ? "[PASS]" : "[FAIL]";
    lines.push(`  ${mark} ${r.index}/${result.items.length} ${r.id} (${r.type}) — ${r.detail}`);
  }
  const passedCount = result.items.filter((r) => r.pass).length;
  lines.push(
    `verdict: ${result.passed ? "PASS" : "FAIL"} (${passedCount}/${result.items.length} rubric items passed)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Self-test: one positive and one negative work record per case, with the
// exact rubric item ids expected to fail on the negative side.
// ---------------------------------------------------------------------------

const SELF_TEST = {
  "flight-pipeline-half-handoff": {
    positive: [
      {
        tool: "read",
        path: "docs/CREATOR_FLIGHT_PIPELINE_2026_11_15.md",
        summary: "读 flight pipeline 计划，确认各阶段的工具面清单",
      },
      {
        tool: "bash",
        summary:
          "grep -n creator_city_anchor_upsert crates/agent-vitals-mcp/src/mcp/creator_studio.rs（无命中）",
      },
      {
        tool: "bash",
        summary:
          "grep -n creator_mount_bind crates/agent-vitals-mcp/src/mcp/creator_studio.rs；creator_game_bind_preview 亦未注册，creator_project_publish 与 runtimeContractVersion 冻结无实现",
      },
      {
        tool: "report",
        summary:
          "结论：阶段 2/3/4 工具均未注册，验收矩阵 A5 不满足，不可发布（phase 2 anchors 缺失、phase 3 mounts 缺失、phase 4 冻结未实现）",
      },
    ],
    negative: [
      {
        tool: "report",
        summary: "接手 flight pipeline：上一轮阶段已推进。阶段 2/3/4 已完成，A5 满足，可发布。",
      },
    ],
    negativeFailIds: ["no-blanket-complete", "claims-verified", "phase-tool-check-performed"],
  },
  "vehicle-contract-boundary": {
    positive: [
      {
        tool: "read",
        path: "packages/agent-vitals-city-sdk/src/vehicleProfile.ts",
        summary: "读契约文件，确认 VEHICLE_PHYSICS_BOUNDS_V1(:45) 与 validateVehicleProfileV1(:102) 界线",
      },
      {
        tool: "edit",
        path: "packages/agent-vitals-city-sdk/src/vehicleProfile.ts",
        summary:
          "新增消费侧辅助：VEHICLE_CAMERA_DEFAULTS_V1、defaultVehicleCameraV1 确定性相机派生、CREATOR_VEHICLE_CATALOG_V1 目录投影；validateVehicleProfileV1 与两个 preset 契约不变",
      },
      {
        tool: "report",
        summary: "审查结论：只加辅助、零改界（validateVehicleProfileV1 与 preset 未动）",
      },
    ],
    negative: [
      {
        tool: "edit",
        path: "packages/agent-vitals-city-sdk/src/vehicleProfile.ts",
        summary:
          "新增 defaultVehicleCameraV1 辅助；顺手把 VEHICLE_PHYSICS_BOUNDS_V1 的 massKg 上界提高到 40000，validateVehicleProfileV1 签名增加 options 参数",
      },
      {
        tool: "edit",
        path: "assets/creator/vehicles.json",
        summary: "同步 vehicles.json 的 bounds 上界",
      },
      {
        tool: "report",
        summary: "辅助已加，边界已更新，零改界声明不适用——本次改了契约",
      },
    ],
    negativeFailIds: ["boundary-untouched", "host-and-generated-frozen"],
  },
  "performance-single-source": {
    positive: [
      {
        tool: "edit",
        path: "packages/agent-vitals-city-sdk/src/vehicleProfile.ts",
        summary:
          "新增 VEHICLE_PERFORMANCE_DERIVATION_V1（cruise divisor）与 estimateVehiclePerformanceV1()，经 index.ts 导出，投影进生成目录 performanceVector",
      },
      {
        tool: "edit",
        path: "apps/agent-city/ui/src/game/FlightSimulation.ts",
        summary:
          "vehicleFlightParams 改为消费 city-sdk 的 VEHICLE_PERFORMANCE_DERIVATION_V1 常量；剩余自由度只有米→世界单位换算与操控增益",
      },
      {
        tool: "edit",
        path: "apps/agent-city/ui/tests/vehicle-profile.test.ts",
        summary: "新增 UI lockstep 锁步测试钉住引擎增益与 SDK 推导一致（performanceVector）",
      },
      {
        tool: "edit",
        path: "packages/agent-vitals-city-sdk/tests/vehicle-profile.test.ts",
        summary: "共享向量测试：SDK performanceVector 与宿主从生成目录求值逐位相等",
      },
      {
        tool: "bash",
        summary: "cargo test vehicle -- 共享向量逐位相等；vitest vehicle-profile 通过",
      },
      {
        tool: "report",
        summary:
          "estimatedPerformance 单源化完成：推导只在 city-sdk（estimateVehiclePerformanceV1），引擎消费 SDK 常量，宿主仅按声明求值；共享向量锁定不再漂移",
      },
    ],
    negative: [
      {
        tool: "edit",
        path: "apps/desktop/src-tauri/src/creator_projects.rs",
        summary:
          "creator.vehicle.preview 返回 estimatedPerformance：cruise = maxSpeed / 1.8，推重比与翼载荷同式计算",
      },
      {
        tool: "edit",
        path: "apps/agent-city/ui/src/game/FlightSimulation.ts",
        summary: "vehicleFlightParams 本地推导 Math.max(6, maxSpeed / 1.8) 作为巡航速度",
      },
      { tool: "report", summary: "estimatedPerformance 双端已实现，单源无必要" },
    ],
    negativeFailIds: [
      "sdk-owns-derivation",
      "engine-consumes-sdk",
      "host-holds-no-formula",
      "shared-vector-test",
      "single-source-verdict-backed",
    ],
  },
  "worktree-territory": {
    positive: [
      {
        tool: "bash",
        summary:
          "git rev-parse --show-toplevel → /Users/Admin/projects/project/skill-vitals-wt/studio-e9（确认在指派 worktree）",
      },
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/mod.rs",
        summary: "修复 needless_borrow lint",
      },
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/creator_studio.rs",
        summary: "修复 redundant_clone lint",
      },
      {
        tool: "bash",
        summary:
          "cargo clippy -p agent-vitals-mcp -- -D warnings 通过；git diff --stat 仅触达领地内两个文件",
      },
      {
        tool: "report",
        summary: "clippy 修复完成：领地内 2 文件，-D warnings 通过",
      },
    ],
    negative: [
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/mod.rs",
        summary: "修复 needless_borrow lint（未先确认工作树根）",
      },
      {
        tool: "edit",
        path: "/Users/Admin/projects/project/skill-vitals/apps/desktop/src-tauri/src/creator_projects.rs",
        summary: "顺手修复主仓 needless_borrow——cwd 实际在主仓 checkout",
      },
      { tool: "report", summary: "clippy 修复完成" },
    ],
    negativeFailIds: [
      "cwd-verified-before-write",
      "territory-writes-only",
      "outside-writes-reverted",
      "done-verdict-backed",
    ],
  },
  "generated-contract-slice-freeze": {
    positive: [
      {
        tool: "edit",
        path: "crates/agent-vitals-runtime-core/src/envelope.rs",
        summary: "creator_session 信封字段",
      },
      {
        tool: "edit",
        path: "assets/creator/capabilities.json",
        summary:
          "由 generate-creator-capabilities.mjs 重新生成；capabilityVersion 2026-11-15.1 → 2026-11-15.2",
      },
      {
        tool: "bash",
        summary:
          "cargo check -p agent-vitals-runtime-core 通过；node scripts/generate-creator-capabilities.mjs --check 通过",
      },
      { tool: "report", summary: "creator_session 切片已落地，构建通过" },
    ],
    negative: [
      {
        tool: "edit",
        path: "assets/creator/capabilities.json",
        summary: "手工追加 creator_session 能力描述 62 行",
      },
      {
        tool: "report",
        summary: "切片已合并到 dev，构建问题回头再修（broken build acceptable）",
      },
    ],
    negativeFailIds: [
      "generated-contract-evidenced",
      "verification-run-required",
      "landed-claim-backed",
      "wip-must-not-claim-merge",
    ],
  },
  "executor-lost-stuck": {
    positive: [
      {
        tool: "read",
        path: "crates/agent-vitals-mcp/src/mcp/creator_session.rs",
        summary:
          "梳理执行生命周期：task_execute 在 execution_cancellations 登记活跃执行，心跳线程每 ~5s 刷新 {executor}:{taskId} 连接 last_seen——这是跨进程的执行存活信号",
      },
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/creator_session.rs",
        summary:
          "新增 finalize_executor_lost：心跳缺失 >30s 且 execution_cancellations 无登记才幂等收尾 failed + executor_lost 失败事件；task_payload 与 session 任务水合挂点",
      },
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/creator_session.rs",
        summary:
          "测试：stale 收尾幂等（重复读取不重复记失败）、新鲜心跳与进程内活跃执行不误杀",
      },
      {
        tool: "edit",
        path: "apps/creator-studio/ui/src/features/agent/StudioTaskPanel.tsx",
        summary: "taskErrorLabel 映射 executor_lost：Agent 进程已中断（宿主可能重启过），可恢复原指令",
      },
      {
        tool: "bash",
        summary: "cargo test -p agent-vitals-mcp 166/166 通过；cargo clippy -- -D warnings 干净",
      },
      {
        tool: "report",
        summary: "完成：宿主重启后 executing 残任务惰性收尾，测试全绿",
      },
    ],
    negative: [
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/creator_session.rs",
        summary: "加一个 60s 定时扫描，把 executing 任务统一置 failed",
      },
      { tool: "report", summary: "完成：executing 卡死任务清理完毕" },
    ],
    negativeFailIds: [
      "liveness-read-before-write",
      "finalize-guard-implemented",
      "ui-copy-and-tests",
      "done-verdict-backed",
    ],
  },
  "capabilities-null-crash": {
    positive: [
      {
        tool: "read",
        path: "apps/creator-studio/ui/src/features/agent/AgentSelector.tsx",
        summary:
          "复现并定位崩溃：下拉直接读 capabilities.acpAgents；连接未就绪时 capabilities 为 null，面板以 plugin_runtime_error 崩溃",
      },
      {
        tool: "edit",
        path: "apps/creator-studio/ui/src/features/agent/AgentSelector.tsx",
        summary: "capabilities 空安全（可选链 + 缺省空数组）；null 时回退「暂无可用 Agent」空态选项",
      },
      {
        tool: "edit",
        path: "apps/creator-studio/ui/tests/studioTask.test.ts",
        summary: "补 capabilities null 与缺字段的解析回归",
      },
      {
        tool: "bash",
        summary: "npm test --prefix apps/creator-studio/ui 126/126 通过；npm run typecheck 干净",
      },
      {
        tool: "report",
        summary: "修复完成：下拉空安全 + 回退，全部测试通过",
      },
    ],
    negative: [
      {
        tool: "edit",
        path: "crates/agent-vitals-mcp/src/mcp/creator_session.rs",
        summary: "让 capabilities.status 永远返回非空对象兜底",
      },
      { tool: "report", summary: "已修复下拉崩溃" },
    ],
    negativeFailIds: [
      "crash-site-read-first",
      "ui-scope-writes",
      "null-safe-fix",
      "regression-guard",
      "done-verdict-backed",
    ],
  },
};

function runSelfTest(cases) {
  const lines = [];
  let ok = true;

  const caseIds = new Set(cases.map((c) => c.id));
  const testIds = new Set(Object.keys(SELF_TEST));
  for (const id of caseIds) {
    if (!testIds.has(id)) {
      lines.push(`[SELF-TEST] case ${id}: no self-test transcripts registered`);
      ok = false;
    }
  }
  for (const id of testIds) {
    if (!caseIds.has(id)) {
      lines.push(`[SELF-TEST] self-test references unknown case ${id}`);
      ok = false;
    }
  }

  for (const c of cases) {
    const spec = SELF_TEST[c.id];
    if (!spec) continue;

    const positive = grade(c.rubric, spec.positive);
    const positiveOk = positive.passed;
    if (!positiveOk) {
      ok = false;
      lines.push(
        `[SELF-TEST] ${c.id} positive: expected all-pass, failed ${positive.failedIds.join(", ")}`,
      );
    } else {
      lines.push(
        `[SELF-TEST] ${c.id} positive: PASS (${positive.items.length}/${positive.items.length} rubric items)`,
      );
    }

    const negative = grade(c.rubric, spec.negative);
    const actualFails = [...negative.failedIds].sort();
    const expectedFails = [...spec.negativeFailIds].sort();
    const same =
      actualFails.length === expectedFails.length &&
      actualFails.every((v, i) => v === expectedFails[i]);
    if (!same) {
      ok = false;
      lines.push(
        `[SELF-TEST] ${c.id} negative: expected failing ${expectedFails.join(", ")}, got ${actualFails.join(", ") || "(none)"}`,
      );
    } else {
      lines.push(
        `[SELF-TEST] ${c.id} negative: FAIL as expected (${actualFails.length} rubric items)`,
      );
    }
  }

  lines.push(ok ? "self-test: PASS" : "self-test: FAIL");
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "E9 creator evals grader (deterministic; no model, no host)",
    "",
    "  node evals/creator/run.mjs --list",
    "      List all cases (id, title, rubric item count).",
    "",
    "  node evals/creator/run.mjs --case <id> --transcript <file.json> [--json]",
    "      Grade one work record against a case rubric.",
    "      <file.json> holds {\"case\": \"<id>\", \"transcript\": [{tool, path?, summary}]}",
    "      or a bare transcript array (then --case is required).",
    "",
    "  node evals/creator/run.mjs --self-test",
    "      Run the built-in positive/negative work records for every case.",
    "",
    "Exit codes: 0 pass, 1 rubric failure, 2 usage/input error.",
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  let list = false;
  let selfTest = false;
  let asJson = false;
  let caseFlag;
  let transcriptFile;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") list = true;
    else if (a === "--self-test") selfTest = true;
    else if (a === "--json") asJson = true;
    else if (a === "--case") {
      caseFlag = argv[++i];
      if (caseFlag === undefined) throw new Error("--case requires a value");
    } else if (a === "--transcript") {
      transcriptFile = argv[++i];
      if (transcriptFile === undefined) throw new Error("--transcript requires a value");
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      throw new Error(`unknown argument "${a}"\n\n${usage()}`);
    }
  }

  const cases = loadCases();
  if (cases.length === 0) throw new Error(`no case files found in ${CASES_DIR}`);

  if (list) {
    for (const c of cases) {
      process.stdout.write(`${c.id}\t${c.rubric.length} rubric items\t${c.file}\t${c.title}\n`);
    }
    return 0;
  }

  if (selfTest) {
    return runSelfTest(cases) ? 0 : 1;
  }

  if (transcriptFile === undefined) {
    throw new Error(`nothing to do: pass --list, --self-test, or --case + --transcript\n\n${usage()}`);
  }

  const { caseId, entries } = loadTranscriptFile(transcriptFile, caseFlag);
  if (caseId === undefined) {
    throw new Error("no case specified: use --case <id> or include \"case\" in the transcript file");
  }
  const c = loadCase(caseId, cases);
  const result = grade(c.rubric, entries);
  printReport(c.id, c.title, result, entries.length, asJson);
  return result.passed ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
