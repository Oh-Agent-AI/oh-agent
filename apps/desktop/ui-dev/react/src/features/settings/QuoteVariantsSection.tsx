import { useEffect, useState } from "react";
import { message, useLanguage, type MessageKey } from "../../lib/i18n";
import { stable } from "../../lib/stable";
import { hasNativeBridge, readQuoteVariants, saveQuoteChoice, type QuoteSource, type QuoteVariantProvider } from "../../lib/tauri";

const SOURCE_KEY: Record<QuoteSource, MessageKey> = {
  user_choice: "qv.source.user",
  default_assumption: "qv.source.assumed",
  base_quote: "qv.source.base",
  pinned_by_user_cards: "qv.source.pinned",
};
const FOLLOW = "";

/**
 * 并列报价：同一服务商官方给了多个币种各一套价（例如 DeepSeek 的美元价与人民币价）。
 * 两套是各自的官方报价，**不是互相换算**——这里只选「按哪一套计费」。没选过时按报告币种
 * 挑，这是一个**默认假设**而不是账户证据，所以界面始终把它标出来；用户一选就按所选。
 */
export function QuoteVariantsSection() {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => message(key, language, parameters);
  const [providers, setProviders] = useState<QuoteVariantProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async () => { const next = await readQuoteVariants(); setProviders((previous) => stable(previous, next)); };
  useEffect(() => {
    let active = true;
    void readQuoteVariants().then((next) => { if (active) setProviders((previous) => stable(previous, next)); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const choose = async (provider: QuoteVariantProvider, value: string) => {
    if (busy) return;
    setBusy(provider.provider); setError(null);
    try { await saveQuoteChoice(provider.provider, value === FOLLOW ? null : value); await reload(); }
    catch (reason: unknown) { setError(reason instanceof Error && reason.message ? reason.message : typeof reason === "string" && reason ? reason : tr("qv.saveFailed")); }
    finally { setBusy(null); }
  };

  // 没有并列报价的服务商、或没有桥接（浏览器预览）：整块不显示。
  if (!hasNativeBridge() || providers.length === 0) return null;

  return <section className="settings-section" id="settings-quote-variants" aria-labelledby="settings-qv-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("qv.eyebrow")}</p><h3 id="settings-qv-title">{tr("qv.title")}</h3><p>{tr("qv.intro")}</p></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="settings-data-card">
      <ul className="settings-custom-list">{providers.map((provider) => {
        const pinned = provider.source === "pinned_by_user_cards";
        const selectId = `quote-choice-${provider.provider}`;
        return <li className="settings-custom-row" key={provider.provider}>
          <div>
            <strong>{provider.label}</strong>
            <span>{tr("qv.using", { currency: provider.active_currency })} · {tr(SOURCE_KEY[provider.source])}</span>
          </div>
          <label htmlFor={selectId} className="visually-hidden">{tr("qv.choose", { name: provider.label })}</label>
          <select id={selectId} value={provider.chosen_currency ?? FOLLOW} disabled={pinned || busy === provider.provider}
            onChange={(event) => void choose(provider, event.target.value)}>
            <option value={FOLLOW}>{tr("qv.follow")}</option>
            {provider.available.map((code) => <option key={code} value={code}>{tr("qv.quotedIn", { currency: code })}</option>)}
          </select>
        </li>;
      })}</ul>
      <p className="settings-data-help">{tr("qv.note")}</p>
    </div>
  </section>;
}
