/**
 * 补价卡表单的纯逻辑（无 React、无桥接，便于单测）。
 *
 * 价卡本身没有币种字段，币种是**服务商级**的：后端 `save_card_checked` 会拒绝与服务商报价币种
 * 不一致的卡。表单在这里就把可选币种限制住，用户根本选不到会被拒绝的组合。
 */
export type RatePair = { off_peak: number; peak: number };
export type PriceCardPayload = {
  provider_id: string; model_id: string; currency: string;
  input_uncached: RatePair; input_cached: RatePair; output: RatePair; cache_write?: RatePair;
};
export type PriceFields = { uncached: string; cached: string; output: string; cacheWrite: string };
export type PriceCardFields = {
  provider: string; model: string; currency: string;
  price: PriceFields;
  /** 峰谷价不同：关着时峰、谷用同一个价（大多数服务商没有峰谷）。 */
  peakDiffers: boolean;
  peak: PriceFields;
};
export type PriceCardFieldError = "provider" | "model" | "currency" | "price";

const DECIMAL = /^\d+(\.\d+)?$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 每百万 token 的价格上限：防手滑多打几个 0。 */
const MAX_PRICE = 1_000_000;

export function parsePrice(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : null;
}

/**
 * 服务商币种已知 → 只能选它；官方给了多套报价（`offered`）且还没被自己的卡钉住 → 只能在这几个里选；
 * 新服务商 → 可选快照里支持的币种。
 */
export function allowedCurrencies(providerCurrency: string | null, supported: string[], offered: string[] = []): string[] {
  if (providerCurrency) return [providerCurrency];
  return offered.length ? offered : supported;
}

export function emptyFields(): PriceCardFields {
  const blank = (): PriceFields => ({ uncached: "", cached: "", output: "", cacheWrite: "" });
  return { provider: "", model: "", currency: "", price: blank(), peakDiffers: false, peak: blank() };
}

export function buildPriceCardPayload(fields: PriceCardFields, providerCurrency: string | null, supported: string[], offered: string[] = []):
  { ok: true; payload: PriceCardPayload } | { ok: false; error: PriceCardFieldError } {
  const provider = fields.provider.trim();
  const model = fields.model.trim();
  if (!PROVIDER.test(provider)) return { ok: false, error: "provider" };
  if (!model || model.length > 120 || /[\u0000-\u001f\u007f]/u.test(model)) return { ok: false, error: "model" };
  const currency = fields.currency.trim();
  if (!allowedCurrencies(providerCurrency, supported, offered).includes(currency)) return { ok: false, error: "currency" };
  const offPeak = fields.price;
  const peak = fields.peakDiffers ? fields.peak : fields.price;
  const pair = (key: keyof PriceFields, required: boolean): RatePair | null | undefined => {
    const low = offPeak[key].trim();
    const high = peak[key].trim();
    if (!required && !low && !high) return undefined; // 可选维度留空
    const lowValue = parsePrice(low);
    const highValue = parsePrice(high);
    return lowValue === null || highValue === null ? null : { off_peak: lowValue, peak: highValue };
  };
  const uncached = pair("uncached", true);
  const cached = pair("cached", true);
  const output = pair("output", true);
  const cacheWrite = pair("cacheWrite", false);
  // 三个必填维度缺一不可（后端同样整卡拒绝半张卡）；可选维度填了就必须合法。
  if (!uncached || !cached || !output || cacheWrite === null) return { ok: false, error: "price" };
  return {
    ok: true,
    payload: {
      provider_id: provider, model_id: model, currency,
      input_uncached: uncached, input_cached: cached, output,
      ...(cacheWrite ? { cache_write: cacheWrite } : {}),
    },
  };
}
