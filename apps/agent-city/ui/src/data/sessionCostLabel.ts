import type { CityUiProjectionV2 } from "@agent-vitals/app-sdk";

export const sessionCostLabel = (session: CityUiProjectionV2["sessions"][number] | undefined, language: "en" | "zh") => {
  const en = language === "en";
  if (!session) return en ? "Not projected" : "未投影";
  const status = session.cost_status ?? { state: "unavailable", reason: "cost_not_projected", has_unresolved: true };
  if (status.reason === "load_on_demand") return en ? "Open details for estimate" : "打开详情查看估价";
  const cost = session.cost_minor;
  if (status.state === "estimated" && cost) {
    const locale = language === "en" ? "en-US" : "zh-CN";
    let amount = `${cost.amount_minor} ${cost.currency} ${en ? "minor units" : "最小货币单位"}`;
    if (/^[A-Z]{3}$/.test(cost.currency)) {
      try {
        const digits = new Intl.NumberFormat(locale, { style: "currency", currency: cost.currency }).resolvedOptions().maximumFractionDigits ?? 2;
        amount = new Intl.NumberFormat(locale, {
          style: "currency", currency: cost.currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
        }).format(cost.amount_minor / (10 ** digits));
      } catch { /* malformed persisted currency stays an explicit raw minor-unit value */ }
    }
    const reference = session.cost_reference_prices;
    if (reference?.length) {
      const dates = [...new Set(reference.map((ref) => new Date(ref.captured_at_ms).toISOString().slice(0, 10)))].join(", ");
      return en ? `${amount} (reference estimate · price cards captured ${dates} UTC · not a historical bill; route/pricing may be uncertain)`
        : `${amount}（参考估价 · 价卡采集于 ${dates} UTC · 非历史账单，路由/价格可能有不确定性）`;
    }
    return en ? `${amount} (estimate${status.has_unresolved ? " · route or pricing uncertain" : ""})`
      : `${amount}（估价${status.has_unresolved ? " · 路由/价格有不确定性" : ""}）`;
  }
  const labels: Record<string, string> = {
    subscription: en ? "Subscription usage (not billed per token)" : "订阅用量（不按 token 单独计费）",
    unpriced: en ? "No compatible price card" : "暂无兼容价格卡",
    unavailable: status.reason.replaceAll("_", "-") === "legacy-aggregate-not-priced"
      ? en ? "Historical aggregate usage cannot be priced by event time" : "历史汇总用量无法按事件时间估价"
      : status.reason === "no-usage-facts" ? en ? "No priceable usage" : "无可计价用量"
      : status.reason === "no-pricing-snapshot" ? en ? "No local price snapshot covers this usage" : "本机暂无可用于该用量的价格快照"
      : status.reason === "partially_priced" ? en ? "Only part of this usage can be estimated (see breakdown)" : "仅部分用量可估价（见分项）"
      : status.reason === "multiple-provider-costs-require-breakdown" ? en ? "Multiple providers: see cost breakdown" : "涉及多个服务商，请查看分项估价"
      : en ? "Estimate unavailable" : "暂不可估价",
  };
  return labels[status.state] ?? (en ? "Estimate unavailable" : "暂不可估价");
};
