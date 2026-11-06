import { useEffect, useState } from "react";
import { resolvedLanguage, useLanguage } from "../../lib/i18n";
import { readClaudeQuota, readCodexQuota, type ClaudeQuotaState, type CodexQuotaWindow, type UsageSourceSummary } from "../../lib/tauri";

/**
 * 决策区（DECISION_AREA_REACT_PORT spec）：旧总览两个 React cutover 回归的移植——
 * 套餐窗口卡「现在该用谁」+ 值回双轨列表。
 *
 * 诚实红线（契约脚本钉住）：
 * - Claude 永无「剩余 N%」——本地日志只在被拒时记额度，正向余量不存在
 *   （ROUTE_UNIT_COST_DECISION_SPEC §8.3.2）。本文件中 used_percent 只出现在
 *   Codex 的解析与守卫里，永不与 claude 分支相邻。
 * - 值回措辞闭集：值回月费 X.X× / 没用够（只值回月费的 X.XX×）/ 数字异常请核对。
 *   倍数基于申报月费（非付款验证）；省钱/损失类措辞禁用（闭集见 spec §1-2）。
 * - Codex 快照三重守卫：缺失/超 24h/未来时间/已过重置 → 「读不到套餐额度」。
 * - 「无配额事件」≠「读不到」：Claude 无快照时按 unknown 态如实展示（评审 P2-2）。
 */

// 双语局部映射：i18n 目录整体迁入前的过渡。语言取应用偏好（resolvedLanguage），
// 不取 navigator.language——后者是系统语言且模块加载时定死，用户在设置里选了
// English 这块仍是中文（美区验收截图抓到的）。t() 每次调用时解析，组件用
// useLanguage() 订阅切换。
type Lang = "zh" | "en";
const currentLang = (): Lang => (resolvedLanguage() === "en" ? "en" : "zh");
const D = {
  cardTitle: { zh: "现在该用谁", en: "Who to use now" },
  cardEyebrow: { zh: "套餐窗口", en: "Plan windows" },
  snapshotNote: { zh: "余量为本地快照，非官方实时", en: "Headroom is a local snapshot, not live" },
  snapshotAt: { zh: "快照", en: "snapshot" },
  codexUnreadable: { zh: "读不到套餐额度", en: "Plan quota unreadable" },
  resetAt: { zh: "重置", en: "resets" },
  remain: { zh: "剩余", en: "remaining" },
  claudeNoSnapshot: { zh: "窗口状态未知（近期无撞窗记录）", en: "State unknown (no recent limit hits)" },
  windowsRecent: { zh: "近 7 天撞窗", en: "hits in 7d" },
  claudeExhausted: { zh: "已耗尽", en: "exhausted" },
  lastReset: { zh: "上次限流已于", en: "last limit cleared at" },
  fiveHour: { zh: "5 小时窗口", en: "5-hour window" },
  sevenDay: { zh: "7 天窗口", en: "7-day window" },
  dualTitle: { zh: "订阅与按量 · 值回对照", en: "Subscription vs metered · payback" },
  dualEyebrow: { zh: "值回双轨", en: "Payback dual track" },
  fixedFee: { zh: "订阅（固定月费）", en: "Subscription (fixed monthly)" },
  listEqRef: { zh: "名义 API 等价（参考）", en: "Nominal API equivalent (reference)" },
  payback: { zh: "值回月费", en: "pays back" },
  underused: { zh: "没用够（只值回月费的", en: "underused (only" },
  underusedTail: { zh: "×）", en: "× of the fee)" },
  anomaly: { zh: "数字异常（折算为月费的", en: "Anomalous (≈" },
  anomalyTail: { zh: "倍），请核对套餐", en: "× the fee); check your plan" },
  notPaymentVerified: { zh: "月费为申报值，非付款验证", en: "fee is declared, not payment-verified" },
  unsetFee: { zh: "尚未设置套餐或账单", en: "No plan or bill declared" },
  goFill: { zh: "去填写 ›", en: "Set it ›" },
  noSubEntries: { zh: "本月没有订阅或名义等价条目（纯按量）", en: "No subscription or nominal entries this month (metered only)" },
  unreadable: { zh: "本月支出明细暂不可读，请刷新重试", en: "Monthly breakdown unreadable; retry" },
  unresolved: { zh: "存在未解析项", en: "has unresolved items" },
  unclassified: { zh: "无法归类", en: "unclassified" },
  viaHarness: { zh: "经", en: "via" },
  unknownProvider: { zh: "未知提供方", en: "unknown provider" },
  unattributed: { zh: "未归属", en: "unattributed" },
  noCurrency: { zh: "（币种未声明）", en: "(currency undeclared)" },
} as const;
const t = (key: keyof typeof D) => D[key][currentLang()];

const providerLabel = (id: string): string => {
  const zh = currentLang() === "zh";
  const labels: Record<string, string> = {
    anthropic: "Anthropic", minimax: "MiniMax", "zhipu-glm": zh ? "智谱 GLM" : "Zhipu GLM",
    openai: "OpenAI", deepseek: "DeepSeek", "deepseek-official": zh ? "DeepSeek 官方" : "DeepSeek (official)",
    shengsuanyun: zh ? "胜算云" : "Shengsuanyun", unknown: t("unknownProvider"), unattributed: t("unattributed"),
    "<unknown>": t("unknownProvider"),
  };
  return labels[id] ?? id;
};

// 旧版 window_label 缺场时的回退按 window 推，不得写死单一尺度（周窗差 33 倍）。
function windowFallbackLabel(window: string): string {
  if (window === "seven_day") return t("sevenDay");
  if (window === "five_hour") return t("fiveHour");
  return window;
}

function fmtClock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtMoney(amount: number, currency: string | null): string {
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : `${currency ?? ""} `;
  return `${symbol}${amount.toFixed(2)}${currency == null ? t("noCurrency") : ""}`;
}

/** Codex 三重守卫（旧版 workbench.js:4379-4382 语义原样移植）。 */
function codexUsable(q: CodexQuotaWindow | null): q is CodexQuotaWindow {
  if (!q) return false;
  const observed = Date.parse(q.observed_at);
  return (
    Number.isFinite(q.used_percent) && q.used_percent >= 0 && q.used_percent <= 100
    && Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= 24 * 60 * 60 * 1000
    && Number.isSafeInteger(q.resets_at) && q.resets_at * 1000 > Date.now()
  );
}

function QuotaWindowCard() {
  useLanguage();
  const [codex, setCodex] = useState<CodexQuotaWindow | null>(null);
  const [claude, setClaude] = useState<ClaudeQuotaState | null>(null);
  useEffect(() => {
    let active = true;
    void readCodexQuota().then((v) => { if (active) setCodex(v); }).catch(() => { if (active) setCodex(null); });
    void readClaudeQuota().then((v) => { if (active) setClaude(v); }).catch(() => { if (active) setClaude(null); });
    return () => { active = false; };
  }, []);
  const usable = codexUsable(codex);
  const remain = usable ? Math.max(0, 100 - codex.used_percent) : null;
  const snapshotAt = usable && codex?.observed_at ? `${t("snapshotAt")} ${fmtClock(Date.parse(codex.observed_at) / 1000)}` : null;
  return (
    <section className="info-panel decision-quota" aria-labelledby="decision-quota-title">
      <div className="section-heading"><div><p className="eyebrow">{t("cardEyebrow")}</p><h3 id="decision-quota-title">{t("cardTitle")}</h3></div><small className="decision-note">{snapshotAt ? `${t("snapshotNote")} · ${snapshotAt}` : t("snapshotNote")}</small></div>
      <ul className="decision-quota-list">
        <li>
          <span className="decision-src">Codex{codex?.plan_type ? ` (${codex.plan_type})` : ""}</span>
          {usable && remain != null ? (
            <span className="decision-quota-line">
              <span className="meter" role="img" aria-label={`${t("remain")} ${remain.toFixed(0)}%`}><span className={`meter-fill${remain < 15 ? " danger" : ""}`} style={{ width: `${remain}%` }} /></span>
              <b className={remain < 15 ? "danger" : ""}>{t("remain")} {remain.toFixed(0)}% · {fmtClock(codex.resets_at)} {t("resetAt")}</b>
            </span>
          ) : <span className="chip muted-chip">{t("codexUnreadable")}</span>}
        </li>
        <li>
          <span className="decision-src">Claude Pro</span>
          {/* 无快照（近期无撞窗）≠ 读不到：按 unknown 态如实展示（评审 P2-2）。 */}
          {claude?.state === "exhausted" ? (
            <b className="danger">{claude.window_label ?? windowFallbackLabel(claude.window)} {t("claudeExhausted")} · {fmtClock(claude.resets_at)} {t("resetAt")}</b>
          ) : claude?.state === "unknown" ? (
            <span className="decision-quota-line">
              <b>{t("claudeNoSnapshot")}</b>
              {claude.windows_recent > 0 ? <small>· {t("windowsRecent")} {claude.windows_recent}{currentLang() === "zh" ? " 次" : ""}</small> : null}
              {claude.last_resets_at && claude.last_resets_at * 1000 < Date.now() ? <small>· {t("lastReset")} {fmtClock(claude.last_resets_at)} {t("resetAt")}</small> : null}
            </span>
          ) : <span className="decision-quota-line"><b>{t("claudeNoSnapshot")}</b></span>}
        </li>
      </ul>
    </section>
  );
}

type PaybackRow = {
  provider: string; harnesses: string[]; fee: number; listEq: number;
  currency: string | null; hasUnresolved: boolean;
};

/** 旧 groupByProvider 语义（workbench.js:4223-4251）：provider+currency 合并跨执行环境行、
 *  金额相加、has_unresolved 取 OR（评审 P2-1）。by_harness freshness React DTO 没有，豁免。
 *  无法归类的行不丢（AGENTS.md 不丢未解析信号）：fee/listEq 全零但 has_unresolved
 *  的组保留展示 unresolved chip；纯按量组也保留（无值回 chip），不静默过滤（P2-3）。 */
function paybackRows(monthly: UsageSourceSummary): PaybackRow[] {
  const groups = new Map<string, PaybackRow>();
  for (const [key, amount] of Object.entries(monthly.by_provider)) {
    const [harness, provider = harness] = key.split("/");
    const bases: Record<string, number> = amount.amounts_by_basis ?? {};
    if (!Object.keys(bases).length && !amount.has_unresolved) continue;
    const id = `${provider}|${amount.currency ?? ""}`;
    const row = groups.get(id) ?? {
      provider, harnesses: [], fee: 0, listEq: 0,
      currency: amount.currency, hasUnresolved: false,
    };
    row.fee += bases["fixed_subscription"] ?? 0;
    row.listEq += bases["api_equivalent"] ?? 0;
    row.hasUnresolved = row.hasUnresolved || amount.has_unresolved;
    if (!row.harnesses.includes(harness)) row.harnesses.push(harness);
    groups.set(id, row);
  }
  return Array.from(groups.values())
    .filter((row) => row.fee > 0 || row.listEq > 0 || row.hasUnresolved)
    .sort((a, b) => (b.fee + b.listEq) - (a.fee + a.listEq));
}

function PaybackDualTrack({ monthly }: { monthly: UsageSourceSummary | null }) {
  useLanguage();
  const rows = monthly ? paybackRows(monthly) : [];
  return (
    <section className="info-panel decision-payback" aria-labelledby="decision-payback-title">
      <div className="section-heading"><div><p className="eyebrow">{t("dualEyebrow")}</p><h3 id="decision-payback-title">{t("dualTitle")}</h3></div><small className="decision-note">{t("notPaymentVerified")}</small></div>
      {!monthly ? <p className="overview-empty">{t("unreadable")}</p>
        : rows.length === 0 ? <p className="overview-empty">{t("noSubEntries")}</p>
        : (
      <ul className="decision-payback-list">
        {rows.map((row) => (
          <li key={`${row.provider}|${row.currency ?? ""}`}>
            <span className="decision-src">{providerLabel(row.provider)}{row.harnesses.length > 1 ? <small>{currentLang() === "zh" ? "（" : "("}{t("viaHarness")} {row.harnesses.join(currentLang() === "zh" ? "、" : ", ")}{currentLang() === "zh" ? "）" : ")"}</small> : null}</span>
            <span className="decision-payback-line">
              {row.fee > 0 ? <span className="chip sub-chip">{t("fixedFee")} {fmtMoney(row.fee, row.currency)}</span> : null}
              {row.listEq > 0 ? <span className="chip diag-chip">{t("listEqRef")} {fmtMoney(row.listEq, row.currency)}</span> : null}
              {row.hasUnresolved ? <span className="chip muted-chip">{row.fee === 0 && row.listEq === 0 ? t("unclassified") : t("unresolved")}</span>
                : row.fee === 0 && row.listEq > 0 ? (
                  <a className="inline-drill" href="#settings-billing" title={t("unsetFee")}>{t("unsetFee")} · {t("goFill")}</a>
                ) : row.fee > 0 && row.listEq > 0 ? (
                  (() => {
                    const mult = row.listEq / row.fee;
                    if (mult > 50) return <span className="chip warn-chip">⚠ {t("anomaly")}{mult.toFixed(0)}{t("anomalyTail")}</span>;
                    if (mult < 0.5) return <span className="chip warn-chip">⚠ {t("underused")}{mult.toFixed(2)}{t("underusedTail")}</span>;
                    return <span className="chip ok-chip">{t("payback")} {mult.toFixed(1)}×</span>;
                  })()
                ) : null}
            </span>
          </li>
        ))}
      </ul>
        )}
    </section>
  );
}

export function DecisionArea({ monthly }: { monthly: UsageSourceSummary | null }) {
  useLanguage();
  return (
    <div className="decision-area">
      <QuotaWindowCard />
      <PaybackDualTrack monthly={monthly} />
    </div>
  );
}
