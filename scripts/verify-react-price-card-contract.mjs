#!/usr/bin/env node
// 补价卡表单纯逻辑的契约测试：币种由服务商决定、三个必填维度缺一不可、价格只收普通十进制。
// 同一份校验后端 `save_card_checked` 也会做一遍；表单在这里先把用户挡在会被拒绝的组合之外。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const uiRequire = createRequire(path.join(ui, "package.json"));
const { buildSync } = uiRequire("esbuild");
const built = buildSync({ entryPoints: [path.join(ui, "react/src/features/settings/priceCardForm.ts")], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
const sandbox = { module: { exports: {} }, exports: {}, Number, Object, String, Array, Math, Set };
vm.createContext(sandbox);
vm.runInContext(built.outputFiles[0].text, sandbox, { filename: "price-card-form.bundle.cjs" });
const { buildPriceCardPayload, emptyFields, allowedCurrencies, parsePrice } = sandbox.module.exports;
const SUPPORTED = ["USD", "CNY", "EUR"];
const fill = (patch = {}, price = {}) => {
  const f = emptyFields();
  return { ...f, provider: "anthropic", model: "claude-sonnet-5-5", currency: "USD", ...patch, price: { ...f.price, uncached: "3", cached: "0.3", output: "15", ...price } };
};
const plain = (value) => JSON.parse(JSON.stringify(value));

// 价格解析：只收普通十进制，拒绝 `3,5`、`0x10`、`1e3`、负数、超大值
for (const bad of ["", "3,5", "0x10", "1e3", "-1", "abc", "1_0", "3.", ".5", "1000001"]) assert.equal(parsePrice(bad), null, `reject ${JSON.stringify(bad)}`);
assert.equal(parsePrice(" 3.25 "), 3.25);
assert.equal(parsePrice("0"), 0);

// 币种：服务商已有报价币种 → 只能用它；新服务商 → 快照支持的币种
assert.deepEqual(plain(allowedCurrencies("USD", SUPPORTED)), ["USD"]);
assert.deepEqual(plain(allowedCurrencies(null, SUPPORTED)), SUPPORTED);

// 正常：峰谷同价时 peak == off_peak；可选的缓存写入留空则不出现
const ok = buildPriceCardPayload(fill(), "USD", SUPPORTED);
assert.equal(ok.ok, true);
assert.deepEqual(plain(ok.payload), { provider_id: "anthropic", model_id: "claude-sonnet-5-5", currency: "USD", input_uncached: { off_peak: 3, peak: 3 }, input_cached: { off_peak: 0.3, peak: 0.3 }, output: { off_peak: 15, peak: 15 } });

// 会被后端拒绝的币种组合在表单就挡住：USD 数字不能存进 CNY 服务商
assert.deepEqual(plain(buildPriceCardPayload(fill({ provider: "minimax", currency: "USD" }), "CNY", SUPPORTED)), { ok: false, error: "currency" });
assert.equal(buildPriceCardPayload(fill({ provider: "brand-new", currency: "" }), null, SUPPORTED).error, "currency", "新服务商必须选币种");
assert.equal(buildPriceCardPayload(fill({ provider: "brand-new", currency: "EUR" }), null, SUPPORTED).ok, true);
assert.equal(buildPriceCardPayload(fill({ provider: "brand-new", currency: "GBP" }), null, SUPPORTED).error, "currency", "快照没有汇率的币种不能当报价币种");

// 服务商 / 型号校验
for (const provider of ["", "Anthropic", "-bad", "a b", "x".repeat(70)]) assert.equal(buildPriceCardPayload(fill({ provider }), "USD", SUPPORTED).error, "provider", `provider ${JSON.stringify(provider)}`);
for (const model of ["", "   ", "m".repeat(121), "bad\u0007name"]) assert.equal(buildPriceCardPayload(fill({ model }), "USD", SUPPORTED).error, "model", `model ${JSON.stringify(model)}`);

// 三个必填维度缺一不可（半张卡会让计价按缺档静默算错）；可选维度填了就必须合法
for (const key of ["uncached", "cached", "output"]) assert.equal(buildPriceCardPayload(fill({}, { [key]: "" }), "USD", SUPPORTED).error, "price", `${key} required`);
assert.equal(buildPriceCardPayload(fill({}, { cacheWrite: "3,75" }), "USD", SUPPORTED).error, "price", "a malformed optional dimension is not silently dropped");
const withWrite = buildPriceCardPayload(fill({}, { cacheWrite: "3.75" }), "USD", SUPPORTED);
assert.deepEqual(plain(withWrite.payload.cache_write), { off_peak: 3.75, peak: 3.75 });

// 峰谷不同：高峰价单独填；漏填高峰价 = 整卡拒绝
const peaked = fill({ peakDiffers: true });
peaked.peak = { uncached: "6", cached: "0.6", output: "30", cacheWrite: "" };
const peakOk = buildPriceCardPayload(peaked, "USD", SUPPORTED);
assert.deepEqual(plain(peakOk.payload.input_uncached), { off_peak: 3, peak: 6 });
assert.deepEqual(plain(peakOk.payload.output), { off_peak: 15, peak: 30 });
peaked.peak.output = "";
assert.equal(buildPriceCardPayload(peaked, "USD", SUPPORTED).error, "price", "peak prices must be complete when the toggle is on");

// 并列报价（官方给了多个币种各一套价）：币种没被自己的卡钉住时，只能在 offered 里选
assert.deepEqual(plain(allowedCurrencies(null, SUPPORTED, ["CNY", "USD"])), ["CNY", "USD"]);
assert.deepEqual(plain(allowedCurrencies("USD", SUPPORTED, ["CNY", "USD"])), ["USD"], "pinned by the user's own cards => only that currency");
assert.equal(buildPriceCardPayload(fill({ provider: "deepseek-official", currency: "USD" }), null, SUPPORTED, ["CNY", "USD"]).ok, true);
assert.equal(buildPriceCardPayload(fill({ provider: "deepseek-official", currency: "EUR" }), null, SUPPORTED, ["CNY", "USD"]).error, "currency", "EUR is in the FX snapshot but not an offered quote");
assert.equal(buildPriceCardPayload(fill({ provider: "deepseek-official", currency: "" }), null, SUPPORTED, ["CNY", "USD"]).error, "currency", "still must choose");

// 验收发现的缺陷：用源码守卫防回归（真正的挂载验证见独立验收记录，仓库里没有 jsdom）。
{
  const src = readFileSync(path.join(ui, "react/src/features/settings/PriceCardSection.tsx"), "utf8");
  assert.match(src, /hasNativeBridge\(\)/, "no native bridge => render nothing (the read helpers return [] instead of throwing, so this must be explicit)");
  assert.match(src, /latest\.current\.provider !== asked\.provider/, "a prefill response for a provider the user has since left must be discarded");
  assert.match(src, /busyRef\.current/, "submit must be re-entrancy guarded, not just the disabled button");
  const early = src.indexOf("if (!available");
  assert.ok(early > 0, "early return not found");
  const lateHooks = src.slice(early + 1).match(/\buse[A-Z][A-Za-z]*\(/g) ?? [];
  assert.deepEqual(lateHooks, [], `hooks called after the early return: ${lateHooks.join(", ")}`);
  assert.doesNotMatch(src, /toFixed\(6\)/, "tiny prices that pass validation must not display as 0");
}
{
  const qv = readFileSync(path.join(ui, "react/src/features/settings/QuoteVariantsSection.tsx"), "utf8");
  assert.match(qv, /default_assumption/, "the default assumption must be labelled in the UI, not presented as fact");
  const early = qv.indexOf("if (!hasNativeBridge()");
  assert.ok(early > 0);
  assert.deepEqual(qv.slice(early + 1).match(/\buse[A-Z][A-Za-z]*\(/g) ?? [], [], "hooks after the early return");
  assert.match(qv, /disabled=\{pinned/, "a provider pinned by the user's own cards must not be switchable here");
}
console.log("React price-card form contract: OK (currency follows the provider, no half cards, plain decimals only)");
