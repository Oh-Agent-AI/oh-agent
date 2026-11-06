#!/usr/bin/env node
// Settings page contract checks. The page talks to several independent local
// projections; every read must be generation-guarded so an older response
// cannot overwrite a newer mutation/readback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/features/settings/SettingsPage.tsx"), "utf8");
const bridge = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/lib/tauri.ts"), "utf8");
const i18n = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/lib/i18n.ts"), "utf8");
const app = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/app/App.tsx"), "utf8");

for (const name of ["sourceRequest", "sourceControlsRequest", "customRequest", "budgetRequest", "billingRequest", "dataRequest", "aboutRequest", "quotaReminderRequest"]) {
  assert.match(source, new RegExp(`const ${name} = useRef\\(0\\)`), `${name} generation missing`);
}
assert.match(source, /const settingsMounted = useRef\(true\)/, "settings mounted guard missing");
assert.match(source, /useEffect\(\(\) => \{\s*settingsMounted\.current = true/u, "settings mounted guard is not re-armed for StrictMode effect replay");
assert.match(source, /settingsMounted\.current = false/, "settings unmount invalidation missing");
assert.equal((source.match(/const mounted = useMountedRef\(\)/g) ?? []).length, 6, "settings child mounted guards are incomplete");
assert.match(source, /if \(!mounted\.current\) return;/, "settings child actions do not stop after unmount");
assert.match(source, /if \(mounted\.current\) set(?:ActionError|Message|Saving|Exporting|Checking|Opening)/, "settings child error/finally state is not guarded");

for (const section of [
  ["sourceRequest", "sourceRequestId = ++sourceRequest.current", "readSourceHealth", "setReport", "setLoading(false)"],
  ["customRequest", "requestId = ++customRequest.current", "readCustomSourceConfig", "setCustomReport", "setCustomLoading(false)"],
  ["budgetRequest", "requestId = ++budgetRequest.current", "readBudgetSettings", "setBudgetReport", "setBudgetLoading(false)"],
  ["billingRequest", "requestId = ++billingRequest.current", "readBillingSettings", "setBillingReport", "setBillingLoading(false)"],
  ["dataRequest", "requestId = ++dataRequest.current", "readStatisticsSettings", "setDataReport", "setDataLoading(false)"],
  ["aboutRequest", "requestId = ++aboutRequest.current", "readAboutDiagnostics", "setAboutReport", "setAboutLoading(false)"],
  ["quotaReminderRequest", "requestId = ++quotaReminderRequest.current", "readQuotaReminderConfig", "setQuotaReminder", "setQuotaReminderLoading(false)"],
]) {
  const [generation, marker, read, success, finallyState] = section;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${generation} request increment missing`);
  const end = source.indexOf("\n  };", start >= 0 ? start : 0);
  const body = source.slice(start >= 0 ? start : 0, end >= 0 ? end : source.length);
  assert.match(body, new RegExp(read), `${generation} read missing`);
  assert.match(body, /settingsMounted\.current && [A-Za-z]+ === [A-Za-z]+\.current/, `${generation} success/error guard missing`);
  assert.match(body, new RegExp(finallyState.replace(/[()]/g, "\\$&")), `${generation} loading state missing`);
  assert.match(body, /settingsMounted\.current && [A-Za-z]+ === [A-Za-z]+\.current/, `${generation} finally guard missing`);
  assert.match(body, new RegExp(success), `${generation} success setter missing`);
}

const sourceStart = source.indexOf("const sourceRequestId = ++sourceRequest.current");
const sourceEnd = source.indexOf("\n  };", sourceStart);
const sourceBody = source.slice(sourceStart, sourceEnd);
assert.match(sourceBody, /sourceControlsRequestId === sourceControlsRequest\.current/, "source controls read is not generation guarded");
assert.match(sourceBody, /sourceRequestId === sourceRequest\.current/, "source health read is not generation guarded");
assert.match(source, /const paused = await setSyncPaused\(!report\.sync\.paused\)/, "pause receipt is not captured");
assert.match(source, /setSyncMessage\(message\(paused \? "sx\.autoPausedMsg" : "sx\.autoResumedMsg", language\)\)/, "pause message does not use backend receipt");
assert.doesNotMatch(source, /await setSyncPaused\([^\n]+\);\s*setSyncMessage\(!report\.sync\.paused/u, "pause message still infers state from stale report");

assert.match(source, /const requestId = await triggerSync\(\);\s*if \(!settingsMounted\.current\) return false;/u, "sync completion does not stop after unmount");
assert.match(source, /const status = await readSyncRequestStatus\(requestId\);\s*if \(!settingsMounted\.current\) return false;/u, "sync polling does not stop after unmount");
assert.match(source, /catch \(reason: unknown\) \{\s*if \(settingsMounted\.current\) \{\s*setSyncMessage\(null\);/u, "sync error state is not unmount guarded");
assert.match(source, /finally \{\s*if \(settingsMounted\.current\) setSyncing\(false\);/u, "sync busy state is not unmount guarded");
assert.match(source, /const paused = await setSyncPaused\([^\n]+\);\s*if \(!settingsMounted\.current\) return;/u, "pause completion does not stop after unmount");
assert.match(source, /const receipt = await setSourceHarnessExcluded\([^\n]+\);\s*if \(!settingsMounted\.current\) return;/u, "source exclusion completion does not stop after unmount");
assert.match(source, /const receipt = await deleteImportedSourceData\([^\n]+\);\s*if \(!settingsMounted\.current\) return;/u, "source deletion completion does not stop after unmount");
assert.match(source, /if \(settingsMounted\.current\) setPauseSaving\(false\);/u, "pause busy state is not unmount guarded");
assert.match(source, /if \(settingsMounted\.current\) setSourceControlHarness\(null\);/u, "source exclusion busy state is not unmount guarded");
assert.match(source, /if \(settingsMounted\.current\) setDeleteBusyHarness\(null\);/u, "source deletion busy state is not unmount guarded");
assert.match(source, /event\.type === "SyncStatusChanged"\)\s*\{\s*\/\/[^\n]*\n\s*refresh\(true\);/u, "dynamic source health does not refresh after sync status changes");
for (const kind of ["manifest_or_source_invalid", "source_busy", "authority_unavailable", "source_unavailable", "ingest_failed"]) {
  assert.ok(bridge.includes(`"${kind}"`), `dynamic source error kind ${kind} is not accepted by the frontend bridge`);
  assert.ok(i18n.includes(`source.error.${kind}`), `dynamic source error kind ${kind} has no localized label`);
}
assert.match(source, /source\.error_kinds\.map\(\(kind\) => sourceErrorLabel\(kind, language\)\)/u, "source diagnostic labels are not rendered in Settings");
assert.match(source, /invoke<McpSetupInfo>\("mcp_setup_info"\)/u, "Settings does not load MCP setup from the native resolver");
assert.match(source, /\["settings-mcp", message\("sx\.navMcp", language\)\]/u, "MCP section is missing from Settings navigation");
assert.match(source, /id="settings-mcp"/u, "MCP settings section is missing");
assert.ok(source.includes('args = ["data-mcp", "serve", "--allow-local-writes"]'), "Codex MCP config does not enable the documented local server");
assert.match(source, /copyToClipboard\(config\)/u, "MCP config copy action is missing");
assert.match(source, /mcpCodexConfig\(mcpInfo\.cli_path\)/u, "Codex MCP config is not offered");
assert.match(source, /mcpInfo\.tools\.map\(\(tool\)/u, "MCP tools are not rendered from runtime tool specs");
assert.match(i18n, /"sx\.mcpTitle":/u, "MCP settings labels are not localized");
assert.match(app, /mainContent\.current\?\.scrollTo\(\{ top: 0, left: 0, behavior: "instant" \}\)/u, "page navigation does not reset the shared main scroll position");
assert.match(app, /if \(page === "settings" && focusSettingSection\) return/u, "settings deep links do not preserve their requested section target");

console.log("React Settings contract: OK (per-projection generations, sync refresh, dynamic error labels, MCP setup/copy, unmount guard, pause receipt)");
