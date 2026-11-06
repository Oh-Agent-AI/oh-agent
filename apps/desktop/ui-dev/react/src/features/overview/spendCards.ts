import type { DailySummary, FxConvertResult, UsageSourceSummary } from "../../lib/tauri";
import { formatMajorMoney, message } from "../../lib/i18n";

/** `amounts`/`notes` 留给汇率展示：折算只改主值与说明，原币种明细永远保留。 */
export type SpendCard = { value: string; detail: string; amounts: Record<string, number>; notes: string[] };

function available(summary: UsageSourceSummary | DailySummary | null): boolean {
  return summary !== null && summary.freshness !== "unavailable" && summary.freshness !== "unknown";
}

function formatAmount(currency: string, amount: number): string {
  return formatMajorMoney(amount, currency);
}

function rankedEntries(values: Record<string, number>): Array<[string, number]> {
  const rank = (currency: string) => currency === "CNY" ? 0 : currency === "USD" ? 1 : 2;
  return Object.entries(values).filter(([, amount]) => amount > 0)
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right));
}

function meteredEstimateNote(summary: UsageSourceSummary | DailySummary): string {
  const hasEstimate = Object.values(summary.metered_view).some((row) => row.declared_estimate > 0 || row.default_estimate > 0);
  return hasEstimate ? message("spend.estimateExcluded") : "";
}

function card(values: Record<string, number>, notes: string[]): SpendCard {
  const entries = rankedEntries(values);
  if (!entries.length) return { value: "—", detail: notes.join(" · ") || message("spend.noVerified"), amounts: {}, notes };
  const [[currency, amount], ...other] = entries;
  const extra = other.length ? message("spend.otherCurrencies", undefined, { amounts: other.map(([unit, value]) => formatAmount(unit, value)).join(" · ") }) : "";
  return { value: formatAmount(currency, amount), detail: [extra, ...notes].filter(Boolean).join(" · "), amounts: Object.fromEntries(entries), notes };
}

export function monthSpendCard(monthly: UsageSourceSummary | null): SpendCard {
  if (!available(monthly) || !monthly) return { value: "—", detail: message("spend.unavailableMonth"), amounts: {}, notes: [] };
  const notes = [rankedEntries(monthly.actual_spend).length ? message("spend.recordedOrDeclared") : monthly.total_tokens > 0 ? message("spend.noConfirmed") : message("spend.noUsageMonth"), meteredEstimateNote(monthly)];
  if (monthly.has_unresolved || monthly.freshness === "partial") notes.push(message("spend.unresolved"));
  if (monthly.freshness === "stale") notes.push(message("spend.staleMonth"));
  return card(monthly.actual_spend, notes);
}

export function todaySpendCard(daily: DailySummary | null, monthly: UsageSourceSummary | null): SpendCard {
  if (!available(daily) || !daily) return { value: "—", detail: message("spend.unavailableToday"), amounts: {}, notes: [] };
  const spend = { ...daily.actual_spend };
  let hasSubscription = false;
  if (available(monthly) && monthly && monthly.month === daily.date.slice(0, 7)) {
    const [year, month] = monthly.month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (const [currency, amount] of Object.entries(monthly.spend_by_basis.fixed_subscription ?? {})) {
      if (amount <= 0) continue;
      spend[currency] = (spend[currency] ?? 0) + amount / daysInMonth;
      hasSubscription = true;
    }
  }
  const notes = [hasSubscription ? message("spend.subscriptionAllocated") : rankedEntries(spend).length ? message("spend.recordedToday") : daily.total_tokens > 0 ? message("spend.noConfirmed") : message("spend.noUsageToday"), meteredEstimateNote(daily)];
  if (daily.has_unresolved || daily.freshness === "partial") notes.push(message("spend.unresolved"));
  if (daily.freshness === "stale") notes.push(message("spend.staleToday"));
  if (!hasSubscription && !available(monthly)) notes.push(message("spend.subscriptionUnknown"));
  return card(spend, notes);
}

/**
 * 报告币种折算（汇率 V2）：每个币种都折得了才改主值；任一币种折不了、或本来就只有报告币种，
 * 原样返回（保持分币种、不拼半折半不折的假合计）。折算后主值带 ≈，说明里先列原币种明细再写出处。
 */
export function applyConversion(spend: SpendCard, conversion: FxConvertResult | null): SpendCard {
  if (!conversion || conversion.unavailable.length > 0 || conversion.items.length === 0) return spend;
  if (conversion.items.every((item) => item.rate_source === "identity")) return spend;
  // 折算结果必须与「这张卡当前的金额」一一对应：同一组币种、金额一致（到分）、没有非法值。
  // 否则（刷新途中拿到旧结果、后端漏了某个币种、NaN / 负数）一律不折算——宁可显示分币种，
  // 也不显示一个与卡片自己的金额对不上、或只折了一半的合计。
  const wanted = Object.entries(spend.amounts).filter(([, amount]) => amount > 0);
  if (wanted.length === 0 || wanted.length !== conversion.items.length) return spend;
  const seen = new Set<string>();
  for (const item of conversion.items) {
    if (![item.amount, item.converted, item.rate].every(Number.isFinite) || item.amount < 0 || item.converted < 0 || item.rate <= 0) return spend;
    // 币种必须唯一（`[EUR, EUR]` 配 `{EUR, USD}` 长度相等、逐项都对得上，却漏了 USD），
    // 且只读卡片自己的属性（`"constructor"` 这类名字会读到原型上的函数）。
    if (seen.has(item.currency) || !Object.prototype.hasOwnProperty.call(spend.amounts, item.currency)) return spend;
    seen.add(item.currency);
    if (Math.abs(spend.amounts[item.currency] - item.amount) >= 0.005) return spend;
  }
  if (!Number.isFinite(conversion.total) || conversion.total < 0) return spend;
  const originals = conversion.items.map((item) => formatAmount(item.currency, item.amount)).join(" · ");
  const bundled = conversion.items.find((item) => item.rate_source === "bundled_snapshot");
  const manual = conversion.items.some((item) => item.rate_source === "user_assumption");
  const note = bundled && manual ? message("fx.noteMixed", undefined, { date: bundled.rate_date ?? "—" })
    : manual ? message("fx.noteManual")
    : message("fx.noteReference", undefined, { date: bundled?.rate_date ?? "—" });
  return {
    ...spend,
    value: `≈ ${formatAmount(conversion.target, conversion.total)}`,
    detail: [originals, note, ...spend.notes].filter(Boolean).join(" · "),
  };
}
