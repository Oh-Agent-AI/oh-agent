#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const require = createRequire(path.join(ui, "package.json"));
const { buildSync } = require("esbuild");
const built = buildSync({
  entryPoints: [path.join(ui, "react/src/lib/i18n.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node20", write: false,
});
const stored = new Map();
let nativePreference = "system";
let nativeSaved = false;
let failNativeSave = false;
const window = {
  dispatchEvent: () => {},
  __TAURI__: { core: { invoke: async (command, args) => {
    if (command === "ui_language_config") return { status: "ok", language: nativePreference, has_preference: nativeSaved };
    if (command === "save_ui_language_config") {
      if (failNativeSave) throw new Error("write failed");
      nativePreference = args.language;
      nativeSaved = true;
      return { status: "saved", language: nativePreference };
    }
    throw new Error(`unexpected command ${command}`);
  } } },
};
const sandbox = { module: { exports: {} }, exports: {}, require, Intl, Number, String, process, window, Event: class {}, localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };
vm.createContext(sandbox);
vm.runInContext(built.outputFiles[0].text, sandbox);
const i18n = sandbox.module.exports;
assert.deepEqual([...i18n.translationIntegrityIssues()], [], "English and Chinese resources must share keys and interpolation parameters");
const pluginHook = readFileSync(path.join(ui, "react/src/app/plugins/usePlugin.tsx"), "utf8");
for (const name of ["City", "Metrics"]) {
  for (const [key, en, zh] of [
    ["plugin.toolbar", `${name} toolbar`, `${name} 工具栏`],
    ["plugin.content", `${name} plugin content`, `${name} 插件内容`],
    ["plugin.ready", `${name} ready`, `${name} 已就绪`],
    ["plugin.retryNamed", `Retry ${name}`, `重试 ${name}`],
    ["plugin.loading", `Loading ${name}…`, `正在加载 ${name}…`],
    ["plugin.diagnostics", "Local diagnostics", "本地诊断"],
  ]) {
    assert.equal(i18n.message(key, "en", { name }), en);
    assert.equal(i18n.message(key, "zh-Hans", { name }), zh);
    assert.ok(pluginHook.includes(`"${key}"`), `${key} must be connected to the generic plugin hook`);
  }
}
assert.ok(!/[\u3400-\u9fff]/u.test(pluginHook), "plugin host must not hardcode Chinese presentation strings");
assert.equal(i18n.message("billing.billMeteredActual", "en"), "Metered actual");
assert.equal(i18n.message("billing.billSubscription", "en"), "Subscription");
assert.notEqual(i18n.message("billing.billMeteredActual", "en"), i18n.message("billing.billHarnessBilled", "en"), "actual metered charges must not be confused with harness-recorded bills");
assert.match(i18n.message("billing.minorUnitsUnknown", "en", { currency: "JPY", amount: 100 }), /currency scale unavailable/, "unknown currency precision must not be silently converted");
assert.equal(i18n.message("source.state.needs_attention", "en"), "Needs attention");
assert.match(i18n.message("source.deleteScope", "en"), /Original logs, manual bills and price cards remain/, "source deletion scope must be legible in English");
const sourceUi = readFileSync(path.join(ui, "react/src/features/settings/SettingsPage.tsx"), "utf8");
const sourceRow = sourceUi.split("function SourceRow(")[1]?.split("type CustomSourceSectionProps")[0] ?? "";
assert.ok(sourceRow.includes('tr("source.deleteConfirm"') && sourceRow.includes('tr("source.latestRecord"'), "source status and destructive confirmation must use bilingual resources");
const currencyPreference = buildSync({
  entryPoints: [path.join(ui, "react/src/lib/currencyPreference.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node20", write: false,
});
const currencySandbox = { module: { exports: {} }, exports: {}, Intl };
vm.createContext(currencySandbox);
vm.runInContext(currencyPreference.outputFiles[0].text, currencySandbox);
const currency = currencySandbox.module.exports;

assert.equal(currency.suggestedInputCurrency("en-US"), "USD");
assert.equal(currency.suggestedInputCurrency("zh-US"), "USD", "interface language must not choose the input currency");
assert.equal(currency.suggestedInputCurrency("en-CN"), "CNY", "English must not imply USD");
assert.equal(currency.suggestedInputCurrency("en-GB"), "CNY", "unsupported regions retain the prior non-US default");
assert.equal(currency.suggestedInputCurrency("not_a_locale"), "CNY");
assert.equal(currency.isEditableCurrency("EUR"), false);
assert.equal(currency.minorToEditableInput(1), "0.01");
assert.equal(currency.minorToEditableInput(Number.MAX_SAFE_INTEGER), "90071992547409.91");
assert.equal(currency.minorToEditableInput(Number.MAX_SAFE_INTEGER + 1), null);

assert.equal(i18n.resolvedLanguage("system", "en-US"), "en");
assert.equal(i18n.resolvedLanguage("system", "zh-CN"), "zh-Hans");
assert.equal(i18n.resolvedLanguage("zh-Hans", "en-US"), "zh-Hans");
assert.equal(i18n.message("count.sessions", "en", { count: 1 }), "1 session");
assert.equal(i18n.message("count.sessions", "en", { count: 2 }), "2 sessions");
assert.equal(i18n.message("count.sessions", "zh-Hans", { count: 2 }), "2 个会话");
assert.match(i18n.formatMinorMoney(1, "USD", "en-US"), /USD\s*0\.01/);
assert.match(i18n.formatMinorMoney(0, "USD", "en-US"), /USD\s*0\.00/);
assert.equal(i18n.formatMinorMoney(null, "USD", "en-US"), "—");
assert.equal(i18n.formatMinorMoney(100, "JPY", "en-US"), "—", "unknown currency exponents must not be divided by 100");
assert.equal(i18n.formatMajorMoney(0.005, "USD", "en-US"), "< USD 0.01");
assert.notEqual(i18n.formatMinorMoney(123456, "USD", "en-US"), i18n.formatMinorMoney(123456, "USD", "de-DE"));
stored.set("agent-vitals.language", "zh-Hans");
await i18n.hydrateLanguagePreference();
assert.equal(nativePreference, "zh-Hans", "first native launch migrates the existing WebView preference");
await i18n.setLanguagePreference("en");
assert.equal(nativePreference, "en");
assert.equal(stored.get("agent-vitals.language"), "en");
failNativeSave = true;
await assert.rejects(i18n.setLanguagePreference("zh-Hans"));
assert.equal(stored.get("agent-vitals.language"), "en", "failed native persistence must not switch the visible language");
failNativeSave = false;
nativePreference = "system";
nativeSaved = true;
await i18n.hydrateLanguagePreference();
assert.equal(stored.get("agent-vitals.language"), "system", "explicit native system choice must not be overridden by stale WebView state");

const bridgeBundle = buildSync({
  entryPoints: [path.join(ui, "react/src/lib/tauri.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node20", write: false,
});
const errorSandbox = { module: { exports: {} }, exports: {}, require, Intl, Number, String, process, localStorage: sandbox.localStorage };
vm.createContext(errorSandbox);
vm.runInContext(bridgeBundle.outputFiles[0].text, errorSandbox);
const localError = (detail) => vm.runInContext(`new Error(${JSON.stringify(detail)})`, errorSandbox);
assert.equal(errorSandbox.module.exports.safeUiError(localError("database access denied /Users/private/source"), "本地失败"), "Permission to read local data is missing.");
assert.equal(errorSandbox.module.exports.safeUiError(localError("unknown /Users/private/source"), "本地失败"), "This local operation is unavailable. Please retry.");
stored.set("agent-vitals.language", "zh-Hans");
assert.equal(errorSandbox.module.exports.safeUiError(localError("database access denied"), "本地失败"), "本地数据读取权限不足");
stored.set("agent-vitals.language", "system");

const tauri = readFileSync(path.join(ui, "react/src/lib/tauri.ts"), "utf8");
const settings = readFileSync(path.join(ui, "react/src/features/settings/SettingsPage.tsx"), "utf8");
const statisticsSection = settings.split("function StatisticsDataSection(")[1]?.split("type AboutSectionProps")[0];
assert.ok(statisticsSection, "statistics and data settings must be present");
assert.doesNotMatch(statisticsSection, /[\p{Script=Han}]/u, "statistics settings must not embed Chinese-only copy");
assert.match(settings, /const header = \["统计月份", "执行环境", "服务商"/, "existing CSV column contract must remain stable");
const billingSection = settings.split("function BillingSection(")[1]?.split("type BudgetSectionProps")[0];
assert.ok(billingSection, "billing section must be present");
assert.doesNotMatch(billingSection, /[\p{Script=Han}]/u, "the billing settings UI must not embed Chinese-only copy");
const aboutSection = settings.split("function AboutSection(")[1]?.split("type BillingSectionProps")[0];
assert.ok(aboutSection, "about and diagnostics section must be present");
assert.doesNotMatch(aboutSection, /[\p{Script=Han}]/u, "the about section must not embed Chinese-only copy");
const quotaSection = settings.split("function QuotaReminderSection(")[1]?.split("function SourceRow(")[0];
assert.ok(quotaSection, "quota reminder section must be present");
assert.doesNotMatch(quotaSection, /[\p{Script=Han}]/u, "the quota reminder section must not embed Chinese-only copy");
assert.match(i18n.message("about.description", "en"), /never uploaded automatically/);
assert.match(i18n.message("quota.description", "en"), /Off by default/);
const sessions = readFileSync(path.join(ui, "react/src/features/sessions/SessionsPage.tsx"), "utf8");
const sessionCosts = readFileSync(path.join(ui, "react/src/features/sessions/costSummary.ts"), "utf8");
const native = readFileSync(path.join(repo, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
assert.match(native, /ui_language_config,/);
assert.match(native, /save_ui_language_config,/);
assert.doesNotMatch(tauri, /timeZone: "Asia\/Shanghai"/);
assert.match(tauri, /currentBudgetMonth\(\(await readStatisticsTimezone\(\)\)\.timezone\)/);
assert.match(settings, /statisticsMonth\(timezone\)/);
assert.match(settings, /statisticsDay\(timezone\)/);
assert.match(settings, /setMonthly\(""\); setDaily\(""\); setMessage\(tr\("budget\.currencyChanged"\)\)/);
assert.match(settings, /setAmendCurrency\(declaration\.currency \?\? suggestedInputCurrency\(\)\)/, "editing must preserve the recorded currency");
assert.match(settings, /minorToEditableInput\(declaration\.amount_minor\)/, "the historical minor-unit amount must be rendered exactly");
assert.match(settings, /setAmendCurrencyChanged\(true\); setAmendAmount\(""\)/, "a currency change must clear the old nominal amount");
assert.match(settings, /amendCurrencyChanged && amendDeclaration\.amount_minor !== null && amountMinor === null/, "a changed currency must require a replacement amount");
assert.match(settings, /amendmentCurrencyUnsupported && <p role="alert">/, "unsupported historical currencies remain read-only and visible");
assert.match(settings, /setCurrency\(estimate\.currency\)/, "budget edit must keep even an unsupported original currency visible");
assert.match(settings, /!isEditableCurrency\(currency\) && <option value=\{currency\}>/, "an unsupported budget currency must not appear as USD or CNY");
assert.match(sessions, /DEFAULT_STATISTICS_TIMEZONE = Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| "UTC"/);
assert.match(sessionCosts, /formatMinorMoney\(cost\.amount_minor, cost\.currency\)/, "session amounts must use the shared locale-aware currency formatter");
const costBundle = buildSync({
  entryPoints: [path.join(ui, "react/src/features/sessions/costSummary.ts")],
  bundle: true, format: "cjs", platform: "node", target: "node20", write: false,
});
const costSandbox = { module: { exports: {} }, exports: {}, require, Intl, Number, String, process, window, localStorage: sandbox.localStorage };
vm.createContext(costSandbox);
vm.runInContext(costBundle.outputFiles[0].text, costSandbox);
const summary = costSandbox.module.exports;
assert.match(summary.formatCost({ amount_minor: 1234, currency: "USD" }), /USD\s*12\.34/);
assert.equal(summary.formatCost({ amount_minor: 1234, currency: "JPY" }), null, "unknown minor-unit currency must not be rendered as dollars or cents");
assert.equal(summary.costReasonText({ reason: "no-price-card" }, "en"), "No price catalog entry for this model");
assert.equal(summary.costReasonText({ reason: "no-price-card" }, "zh-Hans"), "模型没有价卡，无法估算");
const subscriptionDetail = {
  billing_breakdown: [{ billing_mode: "subscription", model_id: "gpt-6-sol", tokens: { total: 100 } }],
  cost_minor: null, cost_status: { reason: "subscription-token-usage-is-not-a-per-token-bill" },
};
assert.equal(summary.sessionCostCard(subscriptionDetail, "en").value, "Subscription");
assert.equal(summary.sessionCostCard(subscriptionDetail, "zh-Hans").value, "订阅");
assert.equal(summary.sessionCostCard(subscriptionDetail, "en").warn, false);

console.log("React i18n/billing contract: OK (locale, plural, amount display, timezone, budget currency)");
