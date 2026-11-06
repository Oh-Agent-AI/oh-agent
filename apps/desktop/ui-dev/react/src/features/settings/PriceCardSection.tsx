import { useEffect, useRef, useState, type FormEvent } from "react";
import { message, useLanguage, type MessageKey } from "../../lib/i18n";
import { stable } from "../../lib/stable";
import {
  deleteUserPriceCard, hasNativeBridge, readFxStatus, readOfficialPriceCard, readPriceCardProviders, readUserPriceCards, saveUserPriceCard,
  type PriceCardProvider, type UserPriceCard,
} from "../../lib/tauri";
import { allowedCurrencies, buildPriceCardPayload, emptyFields, type PriceCardFields, type PriceFields } from "./priceCardForm";

const FALLBACK_CURRENCIES = ["USD", "CNY"];
// 有效数字而不是固定小数位：`0.0000001` 通过了校验，不能在列表里显示成 0。
const fmt = (value: number) => String(Number(value.toPrecision(8)));
const toText = (rates: { off_peak: number; peak: number } | null | undefined): string => (rates ? fmt(rates.off_peak) : "");

/**
 * 补价卡：厂商出了新型号、价目表里还没有时，用户自己补一张卡，把「算不出来」变成「按你填的价算得出来」。
 * 币种是服务商级的：服务商已有报价币种时只能用它（后端也会拒绝不一致的组合，且不做任何换算）；
 * 新服务商才可以选币种，并以第一张卡为准。价格单位是每百万 token。
 */
export function PriceCardSection() {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => message(key, language, parameters);
  const [providers, setProviders] = useState<PriceCardProvider[]>([]);
  const [cards, setCards] = useState<UserPriceCard[]>([]);
  const [supported, setSupported] = useState<string[]>(FALLBACK_CURRENCIES);
  const [available, setAvailable] = useState(true);
  const [fields, setFields] = useState<PriceCardFields>(emptyFields);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [nextProviders, nextCards, fx] = await Promise.all([readPriceCardProviders(), readUserPriceCards(), readFxStatus().catch(() => null)]);
    setProviders((previous) => stable(previous, nextProviders));
    setCards((previous) => stable(previous, nextCards));
    if (fx && fx.supported_currencies.length) setSupported(fx.supported_currencies);
  };
  useEffect(() => {
    let active = true;
    void reload().catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, []);

  const providerId = fields.provider.trim();
  const matched = providers.find((item) => item.id === providerId);
  const providerCurrency = matched?.currency ?? null;
  const offered = matched?.offered ?? [];
  const currencies = allowedCurrencies(providerCurrency, supported, offered);
  // 服务商币种已知时币种就是它，不让用户选出会被拒绝的组合。
  const currency = providerCurrency ?? fields.currency;
  const set = (patch: Partial<PriceCardFields>) => setFields((current) => ({ ...current, ...patch }));
  const setPrice = (peak: boolean, key: keyof PriceFields, value: string) =>
    setFields((current) => ({ ...current, [peak ? "peak" : "price"]: { ...(peak ? current.peak : current.price), [key]: value } }));

  // 防重入：按钮被禁用只拦得住点击，拦不住 requestSubmit / 程序化提交（验收里观察到重复保存）。
  const busyRef = useRef(false);
  const run = async (action: () => Promise<void>, done: MessageKey) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      setNotice(tr(done));
      // 保存已经成功：重新读取失败不能说成「保存失败」，只是列表暂时没刷新。
      try { await reload(); } catch { setError(tr("pc.reloadFailed")); }
    } catch (reason: unknown) { setError(reason instanceof Error && reason.message ? reason.message : typeof reason === "string" && reason ? reason : tr("pc.saveFailed")); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const built = buildPriceCardPayload({ ...fields, currency }, providerCurrency, supported, offered);
    if (!built.ok) { setError(tr(`pc.err.${built.error}` as MessageKey)); return; }
    void run(async () => { await saveUserPriceCard(built.payload); setFields(emptyFields()); }, "pc.saved");
  };

  const latest = useRef({ provider: "", model: "" });
  latest.current = { provider: providerId, model: fields.model.trim() };
  const onPrefill = async () => {
    setError(null); setNotice(null);
    const asked = { provider: providerId, model: fields.model.trim() };
    try {
      const official = await readOfficialPriceCard(asked.provider, asked.model);
      // 等待期间用户换了服务商 / 型号：这份官方价属于别的服务商（可能是别的币种），丢弃，不能填进去。
      if (latest.current.provider !== asked.provider || latest.current.model !== asked.model) return;
      if (!official.found) { setError(official.reason ? tr("pc.officialNotFoundWhy", { reason: official.reason }) : tr("pc.officialNotFound")); return; }
      if (providerCurrency && official.currency !== providerCurrency) { setError(tr("pc.officialCurrencyMismatch", { official: official.currency, provider: providerCurrency })); return; }
      const differs = official.input_uncached.off_peak !== official.input_uncached.peak || official.input_cached.off_peak !== official.input_cached.peak || official.output.off_peak !== official.output.peak;
      setFields((current) => ({
        ...current, currency: official.currency, peakDiffers: differs,
        price: { ...current.price, uncached: toText(official.input_uncached), cached: toText(official.input_cached), output: toText(official.output) },
        peak: { ...current.peak, uncached: fmt(official.input_uncached.peak), cached: fmt(official.input_cached.peak), output: fmt(official.output.peak) },
      }));
      setNotice(tr("pc.prefilled", { currency: official.currency }));
    } catch { setError(tr("pc.officialNotFound")); }
  };

  const priceInput = (label: MessageKey, key: keyof PriceFields, peak: boolean, required: boolean) => (
    <label key={`${peak}-${key}`}><span>{tr(label)}{required ? "" : ` (${tr("pc.optional")})`}</span>
      <input inputMode="decimal" value={(peak ? fields.peak : fields.price)[key]} onChange={(event) => setPrice(peak, key, event.target.value)} placeholder="0.00" autoComplete="off" /></label>
  );

  // 无桥接（浏览器预览）或读取失败：整块不显示，不留空壳。无桥接时读取函数返回空而不是抛错，
  // 所以要显式判断——否则表单会照常出现、提交后还提示「已保存」而什么也没存。
  if (!available || !hasNativeBridge()) return null;

  return <section className="settings-section" id="settings-price-cards" aria-labelledby="settings-pc-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("pc.eyebrow")}</p><h3 id="settings-pc-title">{tr("pc.title")}</h3><p>{tr("pc.intro")}</p></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {notice && <p className="settings-custom-message" role="status" aria-live="polite">{notice}</p>}
    <div className="settings-data-card">
      {cards.length === 0 ? <p className="settings-custom-empty">{tr("pc.none")}</p>
        : <ul className="settings-custom-list">{cards.map((card) => {
          const quote = providers.find((item) => item.id === card.provider)?.currency ?? "";
          return <li className="settings-custom-row" key={`${card.provider}/${card.model}`}>
            <div><strong>{card.provider} · {card.model}</strong>
              <span>{tr("pc.cardSummary", { currency: quote || "—", uncached: fmt(card.input_uncached.off_peak), cached: fmt(card.input_cached.off_peak), output: fmt(card.output.off_peak) })}</span></div>
            <button className="button button-secondary button-small" type="button" disabled={busy} aria-label={tr("pc.removeFor", { name: `${card.provider}/${card.model}` })}
              onClick={() => void run(() => deleteUserPriceCard(card.provider, card.model), "pc.removed")}>{tr("pc.remove")}</button>
          </li>;
        })}</ul>}
      <form className="fx-rate-form price-card-form" onSubmit={onSubmit}>
        <label><span>{tr("pc.provider")}</span>
          <input list="price-card-providers" value={fields.provider} onChange={(event) => set({ provider: event.target.value })} placeholder="anthropic" autoComplete="off" />
          <datalist id="price-card-providers">{providers.map((item) => <option key={item.id} value={item.id}>{item.currency ?? ""}</option>)}</datalist></label>
        <label><span>{tr("pc.model")}</span><input value={fields.model} onChange={(event) => set({ model: event.target.value })} placeholder="claude-sonnet-5-5" autoComplete="off" /></label>
        <label><span>{tr("pc.currency")}</span>
          <select value={currency} disabled={providerCurrency !== null} onChange={(event) => set({ currency: event.target.value })}>
            {providerCurrency === null && <option value="">{tr("pc.chooseCurrency")}</option>}
            {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
          </select></label>
        {priceInput("pc.uncached", "uncached", false, true)}
        {priceInput("pc.cached", "cached", false, true)}
        {priceInput("pc.output", "output", false, true)}
        {priceInput("pc.cacheWrite", "cacheWrite", false, false)}
        <label className="price-card-check"><input type="checkbox" checked={fields.peakDiffers} onChange={(event) => set({ peakDiffers: event.target.checked })} /><span>{tr("pc.peakDiffers")}</span></label>
        {fields.peakDiffers && <>
          {priceInput("pc.uncachedPeak", "uncached", true, true)}
          {priceInput("pc.cachedPeak", "cached", true, true)}
          {priceInput("pc.outputPeak", "output", true, true)}
          {priceInput("pc.cacheWritePeak", "cacheWrite", true, false)}
        </>}
        <div className="price-card-actions">
          <button className="button button-secondary" type="button" disabled={busy || !providerId || !fields.model.trim()} onClick={() => void onPrefill()}>{tr("pc.prefill")}</button>
          <button className="button button-primary" type="submit" disabled={busy}>{tr("pc.save")}</button>
        </div>
      </form>
      <p className="settings-data-help">{tr("pc.unitNote", { currency: currency || "…" })}</p>
    </div>
  </section>;
}
