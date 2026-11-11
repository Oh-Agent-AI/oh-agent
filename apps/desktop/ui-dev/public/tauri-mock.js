// Browser-only Tauri facade for visual iteration.
// Vite injects this file in `serve` mode only; the packaged app keeps the real
// `window.__TAURI__` supplied by Tauri and never loads this facade.
(function installBrowserTauriMock() {
  "use strict";
  if (window.__TAURI__) return;

  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let uiLanguage = "system";
  let hasUiLanguagePreference = false;
  const dayInSystemTimezone = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(value);
    const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return values.year + "-" + values.month + "-" + values.day;
  };
  const today = new Date();
  const isoDay = dayInSystemTimezone(today);
  const month = isoDay.slice(0, 7);
  const previousDay = dayInSystemTimezone(new Date(today.getTime() - 86400000));

  const byProvider = {
    "codex/openai": {
      harness_id: "codex",
      currency: "USD",
      amounts_by_basis: { api_equivalent: 14.82 },
      has_unresolved: false,
      pricing_method: "official-price-card",
      evidence_basis: "route-evidence",
    },
    "claude-code/anthropic": {
      harness_id: "claude-code",
      currency: "USD",
      amounts_by_basis: { fixed_subscription: 20 },
      has_unresolved: true,
      unresolved_reason: "subscription-token-usage-is-not-a-per-token-bill",
      evidence_basis: "official-subscription",
    },
    // 真实场景：MiniMax 订阅 ¥49/月，经 Claude Code 中转使用——与 anthropic 同执行环境、
    // 不同服务商、不同币种，必须各占一行、永不相加（CLAUDE.md 的反面教材）。
    "claude-code/minimax": {
      harness_id: "claude-code",
      currency: "CNY",
      amounts_by_basis: { fixed_subscription: 49, api_equivalent: 56.2 },
      has_unresolved: false,
      pricing_method: "official-price-card",
      evidence_basis: "official-subscription",
    },
    "dsh/deepseek": {
      harness_id: "dsh",
      currency: "CNY",
      amounts_by_basis: { metered_actual: 8.64 },
      has_unresolved: false,
      pricing_method: "official-price-card",
      evidence_basis: "metered-bill",
    },
  };

  // 形状出处：crates/agent-vitals-domain/src/domain/data_contract.rs
  //   MonthlySummary::to_json / DailySummary::to_json（total_actual_spend =
  //   by_provider summable 档按币分桶，含订阅月费；actual_spend_by_basis 是它
  //   的按 basis 拆栏，各栏之和恒等于 total_actual_spend）。日粒度 by_provider
  //   恒无 fixed_subscription（订阅费不摊进日账）——两份 DTO 不能共用一份
  //   by_provider，否则 mock 自己就违反 domain 不变量。
  const dailyByProvider = {
    "codex/openai": { ...byProvider["codex/openai"], amounts_by_basis: { api_equivalent: 0.84 } },
    "claude-code/anthropic": { ...byProvider["claude-code/anthropic"], amounts_by_basis: {} },
    "claude-code/minimax": { ...byProvider["claude-code/minimax"], amounts_by_basis: { api_equivalent: 4.1 } },
    "dsh/deepseek": { ...byProvider["dsh/deepseek"], amounts_by_basis: { metered_actual: 3.21 } },
  };

  // 会话消耗诊断的合成样本：40 个回合，一段原因未明的高未命中（12–14）、一段同一调用
  // 反复失败（18–20，带错误摘要）、一段输入增长（2–16），第 22 回合前长空闲、第 30 回合换模型。
  // 第二个样本会话是 420 个回合（缩略图 + 窗口）；第 25 回合没有任何测量（缺 ended_at_ms，
  // 真实输出就会这样省略——验收 blocker 的来源）。
  function mockInsights(harness, total) {
    const steps = [];
    let ts = 1789000000000;
    for (let i = 1; i <= total; i += 1) {
      // 一处孤立长空闲（22）+ 一串密集长空闲（60,63,66,70,80,90：真机 114 回合的
      // claude-code 会话有 7 处相邻长空闲，原先每处都画完整文字会互相压字）。
      const DENSE_IDLE = new Set([60, 63, 66, 70, 80, 90]);
      const idle = i === 22 ? 47 * 60000 : DENSE_IDLE.has(i) ? (35 + i) * 60000 : 30000;
      ts += idle + 60000;
      const peak = i <= 16 ? 30000 + i * 7000 : 100000 + (i % 5) * 4000;
      const low = i >= 12 && i <= 14;
      const read = low ? 20000 * 3 : peak * 3 - 1500, write = low ? 66000 : 1200, unc = low ? 27000 : 300;
      const notes = i === 22 ? [{ explanation: "possible_cache_expiry", calls: 1 }] : i === 30 ? [{ explanation: "after_model_change", calls: 1 }] : [];
      const step = { index: i, started_at_ms: ts, ended_at_ms: ts + 45000, idle_before_ms: i === 1 ? undefined : idle,
        input: { cache_read: read, cache_write: write, uncached_input: unc }, output: 2700, input_peak: peak,
        hit_rate: Math.round(read / (read + write + unc) * 10000) / 10000, calls: 3,
        model_ids: [i < 30 ? "claude-sonnet-5" : "claude-opus-5-5"],
        tools: { succeeded: 4 + (i % 6), failed: i >= 18 && i <= 20 ? 1 : 0, cancelled: 0, unknown: 0 }, notes,
        nominal_cost: { amounts: [{ amount_minor: 12 + (i % 7), currency: "USD" }], coverage: "full", basis: "nominal" } };
      if (i === 33) step.outcome = "cancelled";
      if (step.idle_before_ms === undefined) delete step.idle_before_ms;
      if (harness === "codex") { step.input.cache_write = 0; }
      if (i === 25) {
        Object.assign(step, { input: { cache_read: 0, cache_write: 0, uncached_input: 0 }, output: 0, input_peak: 0, calls: 0, model_ids: [], tools: { succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }, notes: [] });
        delete step.ended_at_ms; delete step.hit_rate; delete step.idle_before_ms; delete step.nominal_cost;
      }
      steps.push(step);
    }
    const input = steps.reduce((a, s) => ({ cache_read: a.cache_read + s.input.cache_read, cache_write: a.cache_write + s.input.cache_write, uncached_input: a.uncached_input + s.input.uncached_input }), { cache_read: 0, cache_write: 0, uncached_input: 0 });
    const allInput = input.cache_read + input.cache_write + input.uncached_input;
    const share = (tokens) => Math.round(tokens / allInput * 10000) / 10000;
    return {
      schema_version: 1, harness,
      axis: { unit: "turn", turn_starts: total, leading_step: false, fallback: null, steps, unplaced: { usage_facts: 0, workflow_events: 0 } },
      session: { calls: steps.reduce((a, s) => a + s.calls, 0), input, output: steps.reduce((a, s) => a + s.output, 0), nominal_cost: { amounts: [{ amount_minor: 612, currency: "USD" }], coverage: "full", basis: "nominal" } },
      quality: { legacy_fingerprints: 0 },
      diagnostics: [
        { kind: "repeated_failure", steps: { from: 18, to: 20 }, fact: { failures: 3, steps_hit: 3, capability_id: "Bash", same_invocation: true, groups: 1 }, impact: { tokens: 900000, share_of_session_input: share(900000) }, cause: "evidence", evidence: ["error_excerpt"], context_notes: [], remedy_id: "inspect-repeated-failure", failure_exposure: { affected_input_tokens: 900000, nominal_amounts: [{ amount_minor: 612, currency: "USD", billing_basis: "nominal" }, { amount_minor: 900, currency: "CNY", billing_basis: "nominal" }], coverage: "partial", unpriced_tokens: 12000, granularity: "affected-turns", reason: null, disclaimer: "相关回合含正常工作；不是浪费、可节省额或实付账单" } },
        { kind: "input_growth", steps: { from: 2, to: 16 }, fact: { peak_from: 44000, peak_to: 142000, ratio: 3.23 }, impact: { tokens: 3200000, share_of_session_input: share(3200000) }, cause: "unknown", evidence: [], context_notes: [], remedy_id: "review-context-growth" },
        { kind: "high_uncached_input", steps: { from: 12, to: 14 }, fact: { calls: 9, uncached_tokens: 279000 }, impact: { tokens: 279000, share_of_session_input: share(279000) }, explanation: "unexplained", cause: "unknown", evidence: [], context_notes: [], remedy_id: "inspect-uncached-input" },
        // 分散在整个 420 回合里的一串「同一调用反复失败」：默认窗口只显示前 ~90 回合时
        // 大多数落在窗口外——真机 444 回合的会话有 20+ 条窗口外诊断挤在一起（原始
        // bug），用于验证「≤4 条单独编号 / 更多折叠成摘要」的折叠逻辑（2026-09-29）。
        ...(total > 100 ? Array.from({ length: 17 }, (_, k) => {
          const from = 95 + k * 19;
          return { kind: "repeated_failure", steps: { from, to: from + 2 }, fact: { failures: 2 + (k % 3), steps_hit: 2, capability_id: k % 2 ? "Edit" : "Bash", same_invocation: k % 3 !== 0, groups: k % 3 === 0 ? 2 : 1 }, impact: { tokens: 40000 * (k + 1), share_of_session_input: share(40000 * (k + 1)) }, cause: k % 4 ? "evidence" : "unknown", evidence: k % 4 ? ["error_excerpt"] : [], context_notes: [], remedy_id: "inspect-repeated-failure" };
        }) : []),
      ],
      safety: { count: 1, critical: 1, rules: [{ rule: "SV601", severity: "critical", count: 1, steps: [7] }] },
      lanes: { consumption: { state: "available", coverage: 1 }, tools: { state: "available", coverage: 1 } },
    };
  }

  function dto(tokens, opts) {
    const daily = !!(opts && opts.daily);
    return {
      ...(daily ? { date: opts.date || isoDay } : { month: opts && opts.month || month }),
      has_unresolved: true,
      last_observed_at: `${isoDay}T00:00:00Z`,
      tokens_by_harness: {
        codex: { total: Math.round(tokens * 0.46), uncached_input: Math.round(tokens * 0.26), cache_read: Math.round(tokens * 0.12), cache_write: Math.round(tokens * 0.03), output: Math.round(tokens * 0.05) },
        "claude-code": { total: Math.round(tokens * 0.34), uncached_input: Math.round(tokens * 0.20), cache_read: Math.round(tokens * 0.08), cache_write: Math.round(tokens * 0.02), output: Math.round(tokens * 0.04) },
        dsh: { total: Math.round(tokens * 0.20), uncached_input: Math.round(tokens * 0.12), cache_read: Math.round(tokens * 0.04), cache_write: Math.round(tokens * 0.01), output: Math.round(tokens * 0.03) },
      },
      by_provider: daily ? dailyByProvider : byProvider,
      total_actual_spend: daily ? { CNY: 3.21 } : { CNY: 57.64, USD: 20 },
      actual_spend_by_basis: daily
        ? { metered_actual: { CNY: 3.21 } }
        : { fixed_subscription: { CNY: 49, USD: 20 }, metered_actual: { CNY: 8.64 } },
      metered_view: daily
        ? { CNY: { amount: 3.21, actual: 3.21, declared_estimate: 0, default_estimate: 0, label: "actual" } }
        : { CNY: { amount: 8.64, actual: 8.64, declared_estimate: 0, default_estimate: 0, label: "actual" }, USD: { amount: 0, actual: 0, declared_estimate: 0, default_estimate: 0, label: "estimate" } },
      by_harness: {
        codex: { amounts_by_basis: { api_equivalent: 14.82 }, freshness: { state: "fresh", last_observed_at: `${isoDay}T00:00:00Z` }, has_unresolved: false, pricing_method: "provider-card" },
        // by_harness 的 claude-code 条目混币（USD 20 + CNY 49），故不声明 currency（domain 规则：混币条目 currency=None）。
        "claude-code": { amounts_by_basis: { fixed_subscription: 69, api_equivalent: 56.2 }, freshness: { state: "partial", last_observed_at: `${isoDay}T00:00:00Z` }, has_unresolved: true, pricing_method: "fair-market-fallback", unresolved_reason: "missing-provider-route-evidence" },
        dsh: { amounts_by_basis: { metered_actual: 8.64 }, freshness: { state: "fresh", last_observed_at: `${isoDay}T00:00:00Z` }, has_unresolved: false, pricing_method: "provider-card" },
      },
      coverage: { measured_fields: 3, total_fields: 3, denominator_version: 1 },
      excluded_harnesses: [],
      total_summable: daily ? 3.21 : 8.64,
      freshness: { state: "partial", last_observed_at: `${isoDay}T00:00:00Z` },
    };
  }

  // 形状出处：apps/desktop/src-tauri/src/overview.rs SyncStatus::ok →
  //   beijing_timestamp() = runtime::clock::local_timestamp_text，格式
  //   "YYYY-MM-DD HH:MM:SS"（统计时区本地时间，**不是** ISO/UTC）。此前 mock
  //   用 toISOString() 让「上次同步」比同页 note 早 8 小时，是 mock 的错。
  const localStamp = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(value);
    const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return v.year + "-" + v.month + "-" + v.day + " " + v.hour.replace("24", "00") + ":" + v.minute + ":" + v.second;
  };
  const overview = {
    sync: { ok: true, stage: "complete", at: localStamp(new Date()), message: "浏览器样式调试数据" },
    fx: { usd_cny: 7.15, as_of: month },
    today: dto(374000, { daily: true, date: isoDay }),
    month: dto(374000, { month }),
    today_tokens_sql: 374000,
    subscription_cny_month: 49,
    harnesses: [
      { harness_kind: "codex", status: "ready", today_tokens: 172040, today_sessions: 4, recent: [{ title: "浏览器样式调试会话" }] },
      { harness_kind: "claude-code", status: "partial", today_tokens: 127160, today_sessions: 2, recent: [] },
      { harness_kind: "dsh", status: "ready", today_tokens: 74800, today_sessions: 1, recent: [] },
    ],
    days: [{ date: isoDay, total: 0 }],
    // 预算分子 = 跨执行环境按量实付 CNY = 上面 dto() 的 total_actual_spend.CNY（8.64）。
    // 此前 mock 写 68 → 预算卡「¥68」与本月支出卡「¥8.64」同屏打架（2026-09-01
    // 两卡打架事故的形状复刻）。
    budget: { source: "sql", level: "warn", month_ratio: 0.72, month_cost: 8.64, monthly_cny: 12, effective_daily_budget: 0.6, generated_at: new Date().toISOString(), reasons: ["browser mock"] },
    budget_monthly_cny: 12,
    estimate_note: "浏览器调试数据，不会写入本地数据库",
    data_home: "浏览器调试模式",
  };

  // 月界守卫：每月 1 日 previousDay 会落入上月，而桥的 parseUsageCalendar 拒绝
  // 不属于请求月份的 day——只在与 isoDay 同月时才进日历（2026-10-01 契约全红事故）。
  const previousDayInMonth = previousDay.slice(0, 7) === month ? { [previousDay]: { dsh_tokens: 64000, claude_tokens: 64000, codex_tokens: 0, total_tokens: 128000, dsh_cost_cny: 2.34, claude_cost_cny: 0, claude_cost_usd: 1.12, codex_cost_usd: 0 } } : {};
  // OVERVIEW_TREND_RANGE_SPEC：本周/本月档需要「这个月前面几天」才有走势可看——
  // 确定性伪数据（按日号取模，刷新不跳），只补本月里早于 previousDay 的日子。
  const earlierDaysInMonth = {};
  for (let day = 1; day < Number(isoDay.slice(8)) - 1; day += 1) {
    const key = `${month}-${String(day).padStart(2, "0")}`;
    const dsh = (day * 37 % 5) * 18000, claude = ((day * 53 % 7) + 1) * 21000, codex = (day * 29 % 4) * 40000;
    earlierDaysInMonth[key] = { dsh_tokens: dsh, claude_tokens: claude, codex_tokens: codex, total_tokens: dsh + claude + codex, dsh_cost_cny: 0, claude_cost_cny: 0, claude_cost_usd: 0, codex_cost_usd: 0 };
  }
  const calendar = {
    days: {
      ...earlierDaysInMonth,
      ...previousDayInMonth,
      [isoDay]: { dsh_tokens: 52000, claude_tokens: 64000, codex_tokens: 130000, total_tokens: 246000, dsh_cost_cny: 3.21, claude_cost_cny: 0, claude_cost_usd: 0, codex_cost_usd: 0.84 },
    },
  };
  // OVERVIEW_TREND_PANEL v1.1：失败小时标记的 mock（小时 → 次数，键 "0".."23"）。
  // 与 read_hourly_distribution 的形状呼应：09 点是 shape 峰值附近，14 点有
  // claude 参与但失败集中在 codex 侧——预览里橙点落在有柱子的时段。
  const failureHours = { hours: { "9": 3, "14": 1 } };
  // 失败日 mock（OVERVIEW_TREND_RANGE_SPEC §2.2）：今天 + 3 天前 + 8 天前，三档都能看到橙标。
  function failureDaysMock(to) {
    const shift = (n) => { const [y, m, d] = to.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d) - n * 86400000); return t.toISOString().slice(0, 10); };
    return { [to]: 4, [shift(3)]: 2, [shift(8)]: 1 };
  }

  // City 页的浏览器预览数据：page_size ≥ 100 时返回一份确定性的一年跨度合成会话集
  // （4 执行环境 / 对数分布 token / 近期更密 / 少量"正在施工"的活跃会话）。仅供视觉
  // 迭代——打包后的 app 走真实 authority，永不进这条路径。
  const citySessions = (() => {
    let state = 0x2f6e2b1;
    const rand = () => {
      state = Math.imul(state ^ (state >>> 15), state | 1);
      state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
      return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
    };
    const harnesses = [
      { harness: "codex", models: [["gpt-5.6-sol"], ["gpt-5.6-luna"], ["gpt-5.6-terra", "gpt-5.6-sol"]], weight: 0.38 },
      { harness: "claude-code", models: [["claude-sonnet-5"], ["claude-opus-5-5"]], weight: 0.3 },
      { harness: "plugin:zcode", models: [["glm-5"], ["glm-5-air", "glm-5"]], weight: 0.2 },
      { harness: "dsh", models: [["deepseek-v4-flash"]], weight: 0.12 },
    ];
    const now = Date.now();
    const rows = [];
    for (let index = 0; index < 700; index += 1) {
      const pick = rand();
      let entry = harnesses[harnesses.length - 1];
      let acc = 0;
      for (const candidate of harnesses) {
        acc += candidate.weight;
        if (pick <= acc) { entry = candidate; break; }
      }
      // 锚定首个数据日 = 2026-07-23（与真机一致）：预览的时间轴起点/第一个
      // 建筑落在与真实数据同一天，视觉迭代的结论可直接迁移到真机。第 0 条
      // 会话钉在锚点当天，其余按近期更密的偏移分布在锚点至今的范围内。
      const firstDataMs = Date.parse("2026-07-23T00:00:00+08:00");
      const spanDays = Math.max(7, (now - firstDataMs) / 86400000);
      const ageDays = index === 0 ? spanDays : Math.pow(rand(), 1.4) * spanDays;
      const dayStart = now - ageDays * 86400000;
      const durationMinutes = 4 + Math.pow(rand(), 2.2) * 460;
      const tokens = Math.round(2_500 + Math.pow(rand(), 3.2) * 3_400_000);
      const uncached = Math.round(tokens * (0.18 + rand() * 0.3));
      const output = Math.round(tokens * (0.04 + rand() * 0.1));
      const cacheWrite = Math.round(tokens * 0.06);
      const cacheRead = Math.max(0, tokens - uncached - output - cacheWrite);
      const active = rand() > 0.985;
      const last = active ? now - rand() * 240000 : dayStart + durationMinutes * 60000;
      rows.push({
        session_ref: `sr_citymock_${String(index).padStart(4, "0")}`,
        harness: entry.harness,
        first_event_at: new Date(dayStart).toISOString(),
        last_event_at: new Date(Math.min(last, now)).toISOString(),
        event_count: Math.max(2, Math.round(tokens / 9000)),
        model_ids: entry.models[Math.floor(rand() * entry.models.length)],
        tokens: { uncached_input_tokens: uncached, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, output_tokens: output, total: tokens },
        peak_tokens: Math.round(tokens * 0.2),
        cost_minor: entry.harness === "codex" ? { amount_minor: Math.round(tokens / 12000), currency: "USD", basis: "metered_estimate" } : entry.harness === "dsh" ? { amount_minor: Math.round(tokens / 24000), currency: "CNY", basis: "metered_actual" } : null,
        cost_status: entry.harness === "codex" || entry.harness === "dsh" ? { state: "estimated", reason: "metered-estimate", has_unresolved: false } : { state: "subscription", reason: "official-subscription", has_unresolved: true },
      });
    }
    return rows.sort((left, right) => Date.parse(right.first_event_at) - Date.parse(left.first_event_at));
  })();

  const sessions = [{
    session_ref: "sr_browser_mock_01",
    harness: "codex",
    first_event_at: new Date(Date.now() - 3600000).toISOString(),
    last_event_at: new Date().toISOString(),
    event_count: 24,
    model_ids: ["gpt-5.6-sol"],
    tokens: { uncached_input_tokens: 92000, cache_read_tokens: 128000, cache_write_tokens: 12000, output_tokens: 14000, total: 246000 },
    peak_tokens: 34000,
    cost_minor: { amount_minor: 84, currency: "USD", basis: "metered_estimate" },
    cost_status: { state: "estimated", reason: "metered-estimate", has_unresolved: false },
  }, {
    session_ref: "sr_browser_mock_02",
    harness: "claude-code",
    first_event_at: new Date(Date.now() - 7200000).toISOString(),
    last_event_at: new Date(Date.now() - 5400000).toISOString(),
    event_count: 12,
    model_ids: ["deepseek-v4-flash-0731"],
    tokens: { uncached_input_tokens: 32000, cache_read_tokens: 48000, cache_write_tokens: 8000, output_tokens: 10000, total: 98000 },
    peak_tokens: 18000,
    cost_minor: null,
    cost_status: { state: "unavailable", reason: "no-pricing-snapshot", has_unresolved: true },
  }, {
    // 订阅为主 + 少数模型缺价（2026-09-29 真机 codex 会话的缩小版）：4 个模型被订阅声明覆盖，
    // gpt-6-luna / gpt-6-sol 不在声明范围且无价卡 → 后端给 unpriced / no-price-card。
    // 形状出处：crates/agent-vitals-data/src/authority_query.rs::session_billing_buckets
    // 与 ::session_cost_view（billing_mode 经订阅归因改写为 "subscription"，cost_minor 为 null）。
    session_ref: "sr_browser_mock_03",
    harness: "codex",
    first_event_at: new Date(Date.now() - 9 * 86400000).toISOString(),
    last_event_at: new Date(Date.now() - 600000).toISOString(),
    event_count: 8506,
    model_ids: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"],
    tokens: { uncached_input_tokens: 38000000, cache_read_tokens: 1241000000, cache_write_tokens: 0, output_tokens: 2630000, total: 1281630000 },
    peak_tokens: 420000,
    cost_minor: null,
    cost_status: { state: "unpriced", reason: "no-price-card", has_unresolved: true },
  }];
  // 按会话引用单独放：会话行的解析器拒绝未知字段，不能把 mock 专用数据塞进行对象。
  const mockBillingBreakdowns = {
    sr_browser_mock_03: [
      ["gpt-5.6-luna", "subscription", 924600000], ["gpt-5.6-terra", "subscription", 98200000],
      ["gpt-5.6-sol", "subscription", 14900000], ["gpt-6-astra", "subscription", 24400000],
      ["gpt-6-luna", "metered", 109100000], ["gpt-6-sol", "metered", 110300000],
    ],
  };

  const issueGroups = [
    {
      group_id: "browser-issue-group-1", source_kind: "behavior", rule: "SV613",
      harness: "codex", object: "进度停滞: 连续工具失败", evidence_class: "tool_failure",
      bucket: isoDay, count: 3, first_seen_at_ms: Date.now() - 7200000,
      last_seen_at_ms: Date.now() - 3600000, severity: "warning",
      status_rollup: { open: 3, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 },
      sessions_count: 1, sample_evidence: [{ issue_id: "browser-issue-1", evidence: "tool failure", metadata: { category: "tool_failure" } }],
      remedy: { remedy_id: "diagnostic-only", diagnostic_only: true }, actionability: 0.7,
      time: Date.now() - 7200000, evidence: "tool_failure", tool_name: "进度停滞: 连续工具失败", category: "tool_failure", hits: 3, sessions: 1,
    },
    {
      group_id: "browser-issue-group-2", source_kind: "billing_candidate", rule: "BILLING_CONFIRMATION",
      harness: "codex", object: "openai:2026-09", evidence_class: "USD", bucket: month,
      count: 1, first_seen_at_ms: Date.now() - 1800000, last_seen_at_ms: Date.now() - 1800000,
      severity: "warning", status_rollup: { open: 1, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 },
      sessions_count: 0, sample_evidence: [{ candidate_id: "browser-candidate-1", provider_id: "openai", currency: "USD", amount_minor: 2000, is_bill: false }],
      remedy: { remedy_id: "diagnostic-only", diagnostic_only: true }, actionability: 0.8,
      time: Date.now() - 1800000, evidence: "USD", tool_name: "openai:2026-09", category: "USD", hits: 1, sessions: 0,
    },
  ];
  const issueInstances = [{
    issue_id: "browser-issue-1", harness_kind: "codex", session_key: "browser_mock_session",
    rule: "SV613", status: "open", severity: "warning", evidence: "tool failure",
    opened_at_ms: Date.now() - 7200000, closed_at_ms: null, metadata: { category: "tool_failure", time: Date.now() - 7200000 },
  }];

  let syncPaused = false;
  // Shape: crates/agent-vitals-runtime/src/mcp/mod.rs:488-499 source_status_report()
  // 一行一个 harness；生产 error_codes 词表目前只见 permission_denied/permission
  // （mcp/mod.rs:716 测试），file_missing 只在本 mock 里出现过——改用生产词表，
  // 免得设置页规格 §5.6 的映射表在 Vite 里测不到真实分支。
  const sourceStatuses = [
    {
      harness: "codex", source_id: "browser-codex", connection_state: "connected",
      scan: { source_count: 12, last_scanned_at_ms: Date.now() - 3600000 },
      log: { last_event_at_ms: Date.now() - 3600000 },
      import_scope: { sessions: 8, facts: 42, first_event_at_ms: Date.now() - 30 * 86400000, last_event_at_ms: Date.now() - 3600000 },
      recovery_action: null,
    },
    {
      harness: "claude-code", source_id: "browser-claude", connection_state: "needs_attention",
      scan: { source_count: 4, last_scanned_at_ms: Date.now() - 7200000 },
      log: { last_event_at_ms: Date.now() - 7200000 },
      import_scope: { sessions: 3, facts: 18, first_event_at_ms: Date.now() - 20 * 86400000, last_event_at_ms: Date.now() - 7200000 },
      failed_scope: { sources: 1, error_codes: ["permission_denied"] },
      recovery_action: { label: "重新同步", kind: "retry_source" },
    },
    {
      harness: "dsh", source_id: "browser-dsh", connection_state: "connected",
      scan: { source_count: 2, last_scanned_at_ms: Date.now() - 1800000 },
      log: { last_event_at_ms: Date.now() - 1800000 },
      import_scope: { sessions: 2, facts: 9, first_event_at_ms: Date.now() - 5 * 86400000, last_event_at_ms: Date.now() - 1800000 },
      recovery_action: null,
    },
    {
      harness: "workbuddy", source_id: "browser-workbuddy", connection_state: "not_detected",
      scan: { source_count: 0 }, log: {},
      import_scope: { sessions: 0, facts: 0 },
      recovery_action: { label: "扫描并接入", kind: "scan_and_connect" },
    },
  ];
  let sourceDataRevision = 0;
  const customRoots = [];
  let retentionMonths = 13;
  let budgetSnoozedUntilMs = null;
  const budgetConfigState = { monthly_cny_minor: 10000, daily_cny_minor: 500, warning_ratio_bp: 8000, origin: "legacy_import" };
  const budgetProfilesState = {
    estimate: { profile_id: "estimate", currency: "CNY", monthly_minor: 20000, daily_minor: null,
      warning_ratio_bp: 8000, spent_minor: 864, ratio_bp: 432, level: "ok", has_unresolved: false, daily_level: "disabled" },
  };
  const billingCandidates = [{
    candidate_id: "browser-candidate-1", status: "pending", harness: "codex",
    provider_id: "openai", currency: "USD", amount_minor: 2000,
    billing_period_start: month + "-01",
    impact: { status: "ok", total_tokens: 18000, fact_count: 4, session_count: 1 },
  }];
  // 待确认组（形状出处：runtime::billing_preview::confirmation_groups，见 invoke 内注释）。
  // 两组同 harness/provider（候选会挂到第一组下）、一组无价卡排最后；CNY/USD 各一。
  const monthStartMs = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 4, 0, 0);
  const billingGroups = [
    { group_id: "codex|openai|gpt-5.6-sol|session-native|metered_estimate|" + month, harness: "codex",
      provider_id: "openai", model_id: "gpt-5.6-sol", evidence_basis: "session-native",
      pricing_basis: "metered_estimate", tokens: 1_650_000, first_event_at_ms: monthStartMs + 3_600_000,
      last_event_at_ms: monthStartMs + 86_400_000 * 9, session_count: 7, effective_start: month, effective_end: month,
      estimated_amounts: [{ amount_minor: 1892, currency: "USD", basis: "metered_estimate" }],
      unpriced_tokens: 0, unresolved_reason: null },
    { group_id: "claude-code|<unknown>|deepseek-v4-flash|inferred|metered_estimate|" + month, harness: "claude-code",
      provider_id: "<unknown>", model_id: "deepseek-v4-flash", evidence_basis: "inferred",
      pricing_basis: "metered_estimate", tokens: 856_000_000, first_event_at_ms: monthStartMs + 3_600_000,
      last_event_at_ms: monthStartMs + 86_400_000 * 14, session_count: 35, effective_start: month, effective_end: month,
      estimated_amounts: [], unpriced_tokens: 856_000_000, unresolved_reason: "billing-route-unknown" },
    { group_id: "claude-code|minimax|MiniMax-M2.5|missing|metered_estimate|" + month, harness: "claude-code",
      provider_id: "minimax", model_id: "MiniMax-M2.5", evidence_basis: "missing",
      pricing_basis: "metered_estimate", tokens: 980_000, first_event_at_ms: monthStartMs + 7_200_000,
      last_event_at_ms: monthStartMs + 86_400_000 * 6, session_count: 4, effective_start: month, effective_end: month,
      estimated_amounts: [{ amount_minor: 760, currency: "CNY", basis: "metered_estimate" }],
      unpriced_tokens: 0, unresolved_reason: null },
    { group_id: "codex|openai|gpt-5.6-luna|session-native|metered_estimate|" + month, harness: "codex",
      provider_id: "openai", model_id: "gpt-5.6-luna", evidence_basis: "session-native",
      pricing_basis: "metered_estimate", tokens: 120_000, first_event_at_ms: monthStartMs + 3_600_000 * 5,
      last_event_at_ms: monthStartMs + 86_400_000 * 2, session_count: 1, effective_start: month, effective_end: month,
      estimated_amounts: [{ amount_minor: 96, currency: "USD", basis: "metered_estimate" }],
      unpriced_tokens: 0, unresolved_reason: null },
    { group_id: "claude-code|<unknown>|glm-5|missing|metered_estimate|" + month, harness: "claude-code",
      provider_id: "<unknown>", model_id: "glm-5", evidence_basis: "missing",
      pricing_basis: "metered_estimate", tokens: 640_000, first_event_at_ms: monthStartMs + 3_600_000 * 3,
      last_event_at_ms: monthStartMs + 86_400_000 * 4, session_count: 3, effective_start: month, effective_end: month,
      estimated_amounts: [], unpriced_tokens: 640_000, unresolved_reason: "billing-route-unknown" },
    { group_id: "codex|openai|gpt-mystery|missing|unavailable|" + month, harness: "codex",
      provider_id: "openai", model_id: "gpt-mystery", evidence_basis: "missing",
      pricing_basis: "unavailable", tokens: 18_000, first_event_at_ms: monthStartMs + 3_600_000 * 8,
      last_event_at_ms: monthStartMs + 3_600_000 * 8, session_count: 1, effective_start: month, effective_end: month,
      estimated_amounts: [], unpriced_tokens: 18_000, unresolved_reason: "no compatible price card for this provider/model bucket" },
  ];
  // 已被 official_subscription 声明覆盖的组：保存后从组列表消失，撤销后回来
  // （同一谓词在 SQL 里的镜像；见 billing_preview.rs 的 R3 测试）。
  const billingCoveredGroups = new Map();
  // 合成当前订阅声明：用于视觉回归验证“修改订阅/撤销声明”的二次确认和回执。
  const billingDeclarations = [{
    declaration_id: "browser-subscription-decl", revision_id: "browser-subscription-rev-1", current_revision_id: "browser-subscription-rev-1",
    provider_id: "anthropic", relationship_kind: "official_subscription", subscription_name: "Claude Pro",
    amount_minor: 2000, currency: "USD", effective_start: `${month}-01`, effective_end: null, source_candidate_id: null,
    scopes: [{ scope_kind: "provider", scope_value: "unresolved" }], status: "saved",
  }];
  const billingDeclarationHistory = [];
  // 合成失败任务：用于浏览器视觉回归验证“失败任务有证据、可重试、旧结果仍可读”。
  // 真实 Tauri 路径始终以 authority 的 billing_recalculation_jobs 为准。
  const billingJobs = new Map([["browser-failed-recalc", {
    status: "failed", job_id: "browser-failed-recalc", error_code: "重算失败，请重试", requested_at_ms: Date.now() - 3_600_000,
  }]]);
  let pricingNetworkEnabled = true;
  // Claude Pro 额度窗口提醒的开关；**默认关**（与 runtime 的 quota_reminder 同语义）。
  let quotaReminderEnabled = false;
  // 用户补的价卡（浏览器里给一张，方便看"已补卡"列表的样子）。
  const priceOverrideCards = {};
  // 并列报价（DeepSeek 美元/人民币两套官方价）的用户选择；null = 跟随报告币种（默认假设）。
  let quoteChoice = null;
  // 归属声明（浏览器里给一条，方便看列表的样子）。
  const priceOverrideRoutes = { "claude-sonnet-5": { provider: "anthropic", mode: "metered" } };
  const priceOverrideKey = "acme/demo-model-v1";
  priceOverrideCards["deepseek-official"] = {};
  priceOverrideCards["deepseek-official"][priceOverrideKey] = {
    input_uncached: { off_peak: 1.0, peak: 2.0 },
    input_cached: { off_peak: 0.02, peak: 0.04 },
    output: { off_peak: 4.0, peak: 8.0 },
  };
  let pricingLastSuccessAt = Date.now() - 3600000;
  const canonicalIssueStatus = (status) => ({ pending: "open", closed: "resolved", wontfix: "not_applicable" }[status] || status || "open");
  const transitionIssue = (issueId, toStatus) => {
    const instance = issueInstances.find((item) => item.issue_id === issueId);
    if (!instance) throw new Error("issue not found: " + issueId);
    const from = canonicalIssueStatus(instance.status);
    const to = canonicalIssueStatus(toStatus);
    if (from === to) return { status: "ok", issue_id: issueId, to_status: to };
    const group = issueGroups.find((item) => item.sample_evidence?.some((evidence) => evidence.issue_id === issueId));
    if (group) {
      const rollup = group.status_rollup;
      rollup[from] = Math.max(0, Number(rollup[from] || 0) - 1);
      rollup[to] = Number(rollup[to] || 0) + 1;
    }
    instance.status = to;
    return { status: "ok", issue_id: issueId, to_status: to };
  };
  const ok = (data) => Promise.resolve(data);
  const emptyReport = (key) => ({ status: "ok", [key]: [] });
  const trustMonitorConfig = {
    status: "ok", reason: null, enabled: false, interval_seconds: 30, notifications_enabled: false,
    capability: "not_started", last_success_at_ms: null, last_error_code: null,
    updated_at_ms: null, notification_permission: null,
  };
  const trustSnapshot = {
    capability: "macos_lsof_partial", candidate_processes: 1, observations: 2,
    inserted: 2, duplicate: 0, findings_upserted: 1, notification_candidates: 1,
    evidence_links_added: 2,
  };
  const trustProfileSummary = {
    slug: "sample-agent", display_name: "示例 Agent", state: "pending", manifest_hash: "0123456789abcdef",
    discovery_include_count: 1, trust_roots_count: 1, artifact_terms_count: 2, extensions_count: 1,
    trust_adapter: "generic_artifact_v1", watch_priority: "normal",
    source_scope_preview: { roots_count: 1, root_classes: ["home_relative"], covers_workspace_or_project: true, may_include_git_metadata: false, covers_full_filesystem: false, may_leave_home_directory: false },
    trust_scope_preview: { roots_count: 1, root_classes: ["home_relative_app_data"], covers_workspace_or_project: false, may_include_git_metadata: false, home_relative_only: true },
  };
  const trustProfileState = { pending: [{ ...trustProfileSummary }], approved: [] };
  const trustSuppressions = [{ suppression_id: "trust-suppression-SV709-1780000000000", issue_type: "SV709", created_at_ms: Date.now() - 86400000, revoked_at_ms: null }];
  async function invoke(command, args) {
    try {
      switch (command) {
      // budget_profiles 与 "budget_profiles_status" case 共享同一份 budgetProfilesState
      // ——同一份 budget_profiles_status_sql_at 产出，不是第二套预算数据；
      // 两个命令在浏览器 mock 里也不该各算各的（设置页规格 §8 D1）。
      // Shape: apps/desktop/src-tauri/src/overview.rs:348 Overview (Serialize), :86 SyncStatus::ok, :664 budget_profiles
      case "read_overview": return { ...overview, budget: { ...overview.budget,
        snoozed_until: budgetSnoozedUntilMs ? new Date(budgetSnoozedUntilMs).toISOString() : null },
        budget_profiles: { status: "ok", month, profiles: Object.values(budgetProfilesState) } };
      // Composite Overview read, matching the backend's authority-revision bracket.
      case "read_overview_details_snapshot": {
        const requestedMonth = args && args.month || month;
        const requestedDate = args && args.date || isoDay;
        return {
          month: requestedMonth, date: requestedDate,
          monthly: dto(374000, { month: requestedMonth }),
          daily: dto(246000, { daily: true, date: requestedDate }),
          calendar: { month: requestedMonth, days: requestedMonth === month ? calendar.days : {} },
          // Shape: lib.rs overview_details_snapshot_at → issues::failure_hours_day
          //   {date, hours:{hour:count}}；库不可用时后端给 null。mock 恒可用，
          //   非请求日的窗口给空对象（真零），与日历的窗口守卫语义一致。
          failure_hours: requestedDate === isoDay ? { date: requestedDate, hours: failureHours.hours } : { date: requestedDate, hours: {} },
          // Shape: issues::failure_days_trailing {from,to,days:{date:count}}。
          failure_days: { from: requestedDate, to: requestedDate, days: failureDaysMock(requestedDate) },
          authority_revision: 42, is_consistent: true, errors: [],
        };
      }
      // Shape: crates/agent-vitals-domain/src/domain/data_contract.rs:607 DailySummary::to_json.
      case "data_daily_summary": return dto(246000, { daily: true, date: args && args.date });
      // Shape: crates/agent-vitals-domain/src/domain/data_contract.rs:494 MonthlySummary::to_json.
      case "data_monthly_summary": return dto(374000, { month: args && args.month });
      // Shape: apps/desktop/src-tauri/src/lib.rs:2780 read_calendar_month → crates/agent-vitals-runtime/src/summary.rs:1466 calendar_month (json!).
      case "read_calendar_month": return { month: args && args.month || month, days: (args && args.month && args.month !== month) ? {} : calendar.days };
      // Shape: apps/desktop/src-tauri/src/lib.rs:2946 read_hourly_distribution → crates/agent-vitals-runtime/src/summary.rs:689 hourly_distribution (json!):
      //   { date, harnesses_available: { dsh|codex|claude: "sql-facts" | null }, hours: [24 × { hour, dsh_tokens, codex_tokens, claude_tokens }] }
      //   空小时的值是 null 不是 0（渲染器据此画虚线空格）。此前 mock 缺这条，
      //   浏览器里「当日按小时」面板永远显示「读取失败」（2026-09-15 巡检）。
      case "read_hourly_distribution": {
        const date = (args && args.date) || isoDay;
        const hasData = date === isoDay || date === previousDay;
        const shape = [0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 9, 7, 3, 5, 8, 10, 9, 6, 4, 2, 3, 5, 2, 1];
        const hours = shape.map((w, hour) => ({
          hour,
          dsh_tokens: hasData && w > 0 ? w * 1800 : null,
          codex_tokens: hasData && w > 2 ? w * 4200 : null,
          claude_tokens: hasData && hour >= 13 && w > 0 ? w * 2600 : null,
        }));
        return { date, harnesses_available: { dsh: "sql-facts", codex: "sql-facts", claude: hasData ? "sql-facts" : null }, hours };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs:1390 data_status (json!).
      case "data_status": return { status: "ok", data: { health: "warn", integrity: "ok", facts: 42, unresolved_tokens: 18000, unpriced_tokens: 0, pricing: { stale: false }, hints: ["浏览器 mock 数据，不会写入本地库"] } };
      // Shape: apps/desktop/src-tauri/src/lib.rs:1491 billing_import_candidates (json!).
      case "billing_import_candidates": return { status: "ok", candidates: billingCandidates };
      // Shape: crates/agent-vitals-runtime/src/billing_preview.rs::confirmation_groups —
      // 组行来自 summary.rs::unresolved_billing_groups_in（group_id/harness/provider_id/model_id/
      // evidence_basis/pricing_basis/tokens/first_event_at_ms/last_event_at_ms/session_count/
      // effective_start/effective_end），estimated_amounts[{amount_minor,currency,basis}]/
      // unpriced_tokens/unresolved_reason 由 confirmation_groups 补；已按金额降序。
      // Shape: crates/agent-vitals-runtime/src/billing_preview.rs:81 confirmation_groups + summary.rs:917 unresolved_billing_groups_in.
      case "billing_confirmation_groups": {
        const groups = billingGroups.filter((group) => !billingCoveredGroups.has(group.group_id));
        // 与 billing_preview.rs::auto_verdict / clusters_of 同一形状（浏览器里用固定判定）。
        const verdictOf = (g) => {
          // 冲突证据单列：执行环境自报与会话路由证据打架时既不归因也不给一键订阅
          // （billing_preview.rs::auto_verdict 的 conflict 短路）。
          if (g.evidence_basis === "conflict") {
            return { model_vendor: g.provider_id && g.provider_id !== "<unknown>" ? g.provider_id : null, gateway_named: false,
              route_state: "conflict", route_basis: "conflict", billing_party: null, billing_mode: null,
              relationship_kind: null, plan: null, state: "needs_input", question: null, basis: ["route.conflict"] };
          }
          if (g.provider_id === "openai" && g.harness === "codex") {
            return { model_vendor: "openai", gateway_named: false, route_state: "provider_reported", route_basis: g.evidence_basis,
              billing_party: "openai", billing_mode: "subscription", relationship_kind: "official_subscription",
              plan: { label: "ChatGPT", channel: null, anchor_date: null, source: "~/.codex/auth.json auth_mode" },
              state: "determined", question: null, basis: ["harness.provider_reported", "account.ChatGPT"] };
          }
          // 配置证据（billing_preview.rs::auto_verdict 的 relay_config 分支）：基址不是
          // 该厂商官方端点 → 计费方是中转的注册域，状态仍是 one_question。
          if (g.harness === "claude-code" && /^deepseek/.test(g.model_id)) {
            return { model_vendor: "deepseek", gateway_named: false, route_state: "relay_config",
              route_basis: g.evidence_basis, billing_party: "shengsuanyun.com",
              config_endpoint: "router.shengsuanyun.com", billing_mode: "metered", relationship_kind: null,
              plan: null, state: "one_question", question: "route", basis: ["config.endpoint"] };
          }
          if (g.provider_id === "<unknown>" && /^glm/.test(g.model_id)) {
            return { model_vendor: "zhipu-glm", gateway_named: false, route_state: "vendor_shape", route_basis: "inferred",
              billing_party: "zhipu-glm", billing_mode: "metered", relationship_kind: null, plan: null,
              state: "one_question", question: "route", basis: ["response_id.vendor_shape"] };
          }
          if (g.provider_id === "<unknown>") {
            return { model_vendor: null, gateway_named: false, route_state: "unknown", route_basis: g.evidence_basis,
              billing_party: null, billing_mode: null, relationship_kind: null, plan: null, state: "needs_input", question: null, basis: [] };
          }
          return { model_vendor: g.provider_id, gateway_named: false, route_state: "official", route_basis: "session-native",
            billing_party: g.provider_id, billing_mode: null, relationship_kind: null, plan: null,
            state: "one_question", question: "billing_mode", basis: ["route.session-native"] };
        };
        const clusters = new Map();
        for (const g of groups) {
          const v = verdictOf(g);
          // 与 billing_preview.rs::clusters_of 同键：计费方为空时用 model_vendor 补位，
          // 否则不同厂商的网关模型会被并成一行。
          const key = [g.harness, v.billing_party || v.model_vendor || "<unknown>", v.route_state, v.state,
            g.effective_start, g.effective_end].join("|");
          if (!clusters.has(key)) {
            clusters.set(key, { cluster_id: key, harness: g.harness, billing_party: v.billing_party, model_vendor: v.model_vendor,
              provider_id: g.provider_id, evidence_basis: g.evidence_basis, pricing_basis: g.pricing_basis,
              effective_start: g.effective_start, effective_end: g.effective_end, auto_verdict: v,
              models: [], group_ids: [], tokens: 0, session_count: 0, unpriced_tokens: 0, estimated_amounts: [] });
          }
          const c = clusters.get(key);
          c.models.push({ model_id: g.model_id, tokens: g.tokens, session_count: g.session_count, estimated_amounts: g.estimated_amounts, group_id: g.group_id });
          c.group_ids.push(g.group_id); c.tokens += g.tokens; c.session_count += g.session_count; c.unpriced_tokens += g.unpriced_tokens;
          for (const a of g.estimated_amounts) {
            const slot = c.estimated_amounts.find((x) => x.currency === a.currency && x.basis === a.basis);
            if (slot) slot.amount_minor += a.amount_minor; else c.estimated_amounts.push({ ...a });
          }
        }
        const rank = (c) => ({ determined: 0, one_question: 1 }[c.auto_verdict.state] ?? 2);
        return { status: "ok", month: (args && args.month) || month,
          groups: groups.map((g) => ({ ...g, auto_verdict: verdictOf(g) })),
          clusters: [...clusters.values()].sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens) };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs:2688 billing_recalculation_jobs (json!).
      case "billing_recalculation_jobs": return { status: "ok", jobs: [...billingJobs.values()] };
      // Shape: apps/desktop/src-tauri/src/lib.rs:2423 billing_declarations (json!).
      case "billing_declarations": return { status: "ok", declarations: billingDeclarations };
      // Shape: apps/desktop/src-tauri/src/lib.rs:1558 resolve_billing_import_candidate (json!).
      case "resolve_billing_import_candidate": {
        const candidate = billingCandidates.find((item) => item.candidate_id === (args && args.candidateId));
        if (!candidate) throw new Error("billing candidate not found");
        const decision = args && args.decision;
        // lib.rs::candidate_decision_status：accept 不再是直接决定（只能经保存声明）。
        if (decision === "accept") throw new Error("accepting a candidate requires saving a billing declaration");
        candidate.status = decision === "reopen" ? "pending" : "dismissed";
        return { status: candidate.status, changed: true };
      }
      // Shape: crates/agent-vitals-runtime/src/billing_preview.rs::declaration_impact_preview —
      // {status, harness, provider_id, relationship_kind, effective_start, effective_end, scopes[],
      //  changes_amounts, moved{fact_count,session_count,tokens,unpriced_tokens,amounts[],estimated_amounts[]},
      //  kept{tokens,unpriced_tokens,amounts[]}, pending{fact_count,tokens,reasons[]}, first/last_event_ts_ms}
      // Shape: crates/agent-vitals-runtime/src/billing_preview.rs:20 declaration_impact_preview（经 lib.rs:2474）.
      case "billing_candidate_impact_preview": {
        const scopes = (args && args.scopes) || [];
        const models = scopes.filter((scope) => scope.scope_kind === "model").map((scope) => scope.scope_value);
        const providerUnresolved = scopes.some((scope) => scope.scope_kind === "provider" && scope.scope_value === "unresolved");
        // 批量：多个 model 作用域 = 多组求和；服务商未知的组按 "<unknown>" 匹配。
        const matched = billingGroups.filter((item) => item.harness === (args && args.harness)
          && item.provider_id === (providerUnresolved ? "<unknown>" : (args && args.providerId))
          && (!models.length || models.includes(item.model_id)));
        const group = matched.length ? {
          harness: matched[0].harness, provider_id: matched[0].provider_id,
          tokens: matched.reduce((sum, item) => sum + item.tokens, 0),
          session_count: matched.reduce((sum, item) => sum + item.session_count, 0),
          unpriced_tokens: matched.reduce((sum, item) => sum + item.unpriced_tokens, 0),
          estimated_amounts: Object.values(matched.flatMap((item) => item.estimated_amounts).reduce((acc, amount) => {
            const key = amount.currency + "|" + amount.basis;
            acc[key] = acc[key] ? { ...acc[key], amount_minor: acc[key].amount_minor + amount.amount_minor } : { ...amount };
            return acc;
          }, {})),
          first_event_at_ms: Math.min(...matched.map((item) => item.first_event_at_ms)),
          last_event_at_ms: Math.max(...matched.map((item) => item.last_event_at_ms)),
        } : null;
        if (!group) {
          return { status: "ok", harness: args && args.harness, provider_id: args && args.providerId,
            relationship_kind: args && args.relationshipKind, effective_start: args && args.effectiveStart,
            effective_end: args && args.effectiveEnd, scopes, changes_amounts: (args && args.relationshipKind) === "official_subscription",
            moved: { fact_count: 0, session_count: 0, tokens: 0, unpriced_tokens: 0, amounts: [], estimated_amounts: [] },
            kept: { tokens: 0, unpriced_tokens: 0, amounts: [] }, pending: { fact_count: 0, tokens: 0, reasons: [] },
            first_event_ts_ms: null, last_event_ts_ms: null };
        }
        const changesAmounts = (args && args.relationshipKind) === "official_subscription";
        const others = billingGroups.filter((item) => !matched.includes(item) && item.harness === group.harness && item.provider_id === group.provider_id);
        const keptTokens = others.reduce((sum, item) => sum + item.tokens, 0);
        const keptAmounts = others.flatMap((item) => item.estimated_amounts);
        return { status: "ok", harness: group.harness, provider_id: group.provider_id,
          relationship_kind: args && args.relationshipKind, effective_start: args && args.effectiveStart,
          effective_end: args && args.effectiveEnd, scopes, changes_amounts: changesAmounts,
          moved: { fact_count: group.session_count * 3, session_count: group.session_count, tokens: group.tokens,
            unpriced_tokens: group.unpriced_tokens, amounts: changesAmounts ? group.estimated_amounts : [],
            estimated_amounts: group.estimated_amounts },
          kept: { tokens: keptTokens, unpriced_tokens: 0, amounts: keptAmounts },
          pending: { fact_count: 0, tokens: 0, reasons: [] },
          first_event_ts_ms: group.first_event_at_ms, last_event_ts_ms: group.last_event_at_ms };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs save_billing_declaration_revision —
      // {status:"saved", revision_id, declaration_id, changed, job: null | {job_id, status, changed}}；
      // 桌面命令层校验 validate_desktop_declaration（unknown 拒绝、effective_end 必填且 ≤ 当月）。
      // Shape: apps/desktop/src-tauri/src/lib.rs:2363 save_billing_declaration_revision (json!).
      case "save_billing_declaration_revision": {
        if ((args && args.relationshipKind) === "unknown") {
          throw new Error("\"unknown\" is not a billing declaration; keep the group pending instead");
        }
        if (args && args.effectiveEnd && args.effectiveEnd > isoDay) {
          throw new Error("effective_end must not be later than the current statistics month");
        }
        const candidate = billingCandidates.find((item) => item.candidate_id === (args && args.sourceCandidateId));
        if (candidate) candidate.status = "accepted";
        const priorIndex = billingDeclarations.findIndex((item) => item.declaration_id === (args && args.declarationId));
        if (priorIndex >= 0 && args && args.supersedesRevisionId) billingDeclarationHistory.push({ ...billingDeclarations.splice(priorIndex, 1)[0], status: "superseded" });
        billingDeclarations.push({
          declaration_id: args && args.declarationId,
          revision_id: args && args.revisionId,
          provider_id: args && args.providerId,
          relationship_kind: args && args.relationshipKind,
          amount_minor: args && args.amountMinor,
          currency: args && args.currency,
          effective_start: args && args.effectiveStart,
          effective_end: args && args.effectiveEnd,
          source_candidate_id: args && args.sourceCandidateId,
          scopes: (args && args.scopes) || [],
          current_revision_id: args && args.revisionId,
          status: "saved",
        });
        let job = null;
        if (["official_subscription", "official_api", "third_party", "organization"].includes(args && args.relationshipKind)) {
          const jobId = "billing-" + (args && args.revisionId);
          billingJobs.set(jobId, { status: "succeeded", job_id: jobId });
          const scopes = (args && args.scopes) || [];
          const models = scopes.filter((scope) => scope.scope_kind === "model").map((scope) => scope.scope_value);
          const providerUnresolved = scopes.some((scope) => scope.scope_kind === "provider" && scope.scope_value === "unresolved");
          for (const group of billingGroups) {
            if (group.harness === args.harness
                && group.provider_id === (providerUnresolved ? "<unknown>" : args.providerId)
                && (!models.length || models.includes(group.model_id))) {
              billingCoveredGroups.set(group.group_id, args.declarationId);
            }
          }
          job = { job_id: jobId, status: "queued", changed: true };
        }
        return { status: "saved", declaration_id: args && args.declarationId, revision_id: args && args.revisionId, changed: true, job };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs:2629 enqueue_billing_recalculation (json!).
      case "enqueue_billing_recalculation": {
        billingJobs.set(args && args.jobId, { status: "succeeded", job_id: args && args.jobId });
        return { status: "queued", job_id: args && args.jobId, changed: true };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs:2649 retry_billing_recalculation (json!).
      case "retry_billing_recalculation": {
        billingJobs.set(args && args.jobId, { status: "succeeded", job_id: args && args.jobId });
        return { status: "queued", job_id: args && args.jobId, changed: true };
      }
      // Shape: apps/desktop/src-tauri/src/lib.rs:2668 billing_recalculation_job_status (json!).
      case "billing_recalculation_job_status": return billingJobs.get(args && args.jobId) || { status: "missing" };
      // Shape: apps/desktop/src-tauri/src/lib.rs:2451 revoke_billing_declaration (json!).
      case "revoke_billing_declaration": {
        const index = billingDeclarations.findIndex((item) => item.declaration_id === (args && args.declarationId));
        const current = index >= 0 ? billingDeclarations.splice(index, 1)[0] : null;
        billingDeclarationHistory.push({ ...(current || {}), declaration_id: args && args.declarationId, revision_id: args && args.revisionId, current_revision_id: null, status: "revoked" });
        for (const [groupId, declarationId] of [...billingCoveredGroups.entries()]) {
          if (declarationId === (args && args.declarationId)) billingCoveredGroups.delete(groupId);
        }
        return { status: "revoked", declaration_id: args && args.declarationId, revision_id: args && args.revisionId, changed: index >= 0 };
      }
      case "harness_bills_for_period": return emptyReport("bills");
      // Shape: apps/desktop/src-tauri/src/lib.rs:2632 data_source_status (json!).
      case "data_source_status": return { status: "ok", sources: sourceStatuses };
      case "source_harness_controls": return { status: "ok", excluded_harnesses: sourceStatuses.filter((source) => source.connection_state === "excluded").map((source) => source.harness), supported_harnesses: ["claude-code", "codex", "dsh", "workbuddy"] };
      case "source_data_revision": return { status: "ok", revision: sourceDataRevision };
      case "custom_source_roots": return { status: "ok", sources: customRoots };
      // Shape: crates/agent-vitals-runtime/src/budget.rs:140-152（万分比，8000=80%）；
      // 旧字段名沿用 apps/desktop/src-tauri/src/lib.rs:2142 budget_config()。
      case "budget_config": return { status: "ok", ...budgetConfigState };
      case "save_budget_config": {
        const input = (args && args.input) || {};
        Object.assign(budgetConfigState, {
          monthly_cny_minor: input.monthly_cny_minor, daily_cny_minor: input.daily_cny_minor,
          warning_ratio_bp: input.warning_ratio_bp, origin: "user",
        });
        return ok({ status: "saved", updated_at_ms: Date.now(), notification_permission: "granted" });
      }
      case "budget_profiles_status": return { status: "ok", month, profiles: Object.values(budgetProfilesState), coverage: { measured_fields: 1, total_fields: 1 }, freshness: { state: "fresh", last_observed_at: `${isoDay}T00:00:00Z` } };
      case "save_budget_profile": {
        const input = (args && args.input) || {};
        if (!input.profile_id || !Number.isSafeInteger(input.monthly_minor) || input.monthly_minor <= 0) {
          throw new Error("budget profile requires a positive integer monthly_minor");
        }
        const spent = budgetProfilesState[input.profile_id] ? budgetProfilesState[input.profile_id].spent_minor || 0 : 0;
        const ratioBp = Math.round((spent * 10000) / input.monthly_minor);
        budgetProfilesState[input.profile_id] = {
          profile_id: input.profile_id, currency: input.currency, monthly_minor: input.monthly_minor,
          daily_minor: input.daily_minor ?? null, warning_ratio_bp: input.warning_ratio_bp,
          spent_minor: spent, total_spent_minor: spent, ratio_bp: ratioBp,
          daily_spent_minor: 0, daily_total_minor: 0, daily_ratio_bp: null,
          level: ratioBp >= 10000 ? "exceeded" : ratioBp >= input.warning_ratio_bp ? "warn" : "ok",
          has_unresolved: false, daily_level: input.daily_minor ? "ok" : "disabled",
        };
        return ok({ status: "saved", profile_id: input.profile_id, currency: input.currency, notification_permission: "granted" });
      }
      case "disable_budget_profile": {
        const changed = Boolean(budgetProfilesState.estimate);
        delete budgetProfilesState.estimate;
        return ok({ status: "disabled", profile_id: "estimate", changed });
      }
      case "snooze_budget_current_period": {
        budgetSnoozedUntilMs = Date.parse(month + "-28T23:59:59+08:00");
        return ok({ status: "ok", snoozed_until_ms: budgetSnoozedUntilMs });
      }
      case "clear_budget_snooze": {
        budgetSnoozedUntilMs = null;
        return ok({ status: "ok" });
      }
      case "retention_config": return { status: "ok", months: retentionMonths, minimum_months: 1, maximum_months: 60 };
      case "skills_doctor_report": {
        const selectedHarness = (args && args.harness) || "all";
        const summaryHarness = selectedHarness === "all" ? "claude-code" : selectedHarness;
        return {
          schema_version: "1.0",
          run: "browser-skill-preview",
          harness_selection: selectedHarness,
          desktop_meta: { generated_at_ms: Date.now(), from_cache: false, harness: selectedHarness },
          diagnostics: [{ code: "SV501", name: "提示注入模式", severity: "warning", skill: "browser-preview", evidence: { count: 1 }, impact: "发现 1 条需要人工复核的启发式命中。", recommendation: "打开对应 skill 定义后人工复核。", caveats: ["启发式命中不是恶意结论。"] }],
          not_assessed: [{ code: "SV003", name: "描述长度", reason: "当前执行环境没有可辩护的统一阈值。" }],
          report: { harness_summaries: { [summaryHarness]: { skills_on_disk: 12, discoverable_skills: 8, runtime_verified_loaded_skills: null, unique_discoverable_skills: 8, description_budget: { available: true, source: "configurable", budget_chars: 15000, used_chars: 4200, pct_used: 28 }, trigger_data: "available" } } }
        };
      }
      case "skills_snapshot_save": return { status: "saved", upload_performed: false };
      case "skills_diff_latest": return { schema_version: "skills-diff-v1", status: "ok", baseline_available: true, truncated: false, dropped_rows: 0, summary: { added: 1, removed: 0, usage_changed: 1, newly_judgeable: 0, new_overlap_candidates: 0, new_security_findings: 1 }, added_skills: [{ harness: "claude-code", name: "browser-preview", namespace: null, instance_id: null }], removed_skills: [], usage_delta: [{ harness: "claude-code", name: "browser-preview", namespace: null, instance_id: null, delta: 2, now: 8 }], newly_judgeable: [], new_overlap_candidates: [], new_security_findings: [{ skill: "browser-preview", rule: "SV501", line: 12 }], budget_delta_chars: null, budget_pct_then_now: [null, null], loaded_then_now: [8, 9] };
      case "save_retention_config": {
        const input = (args && args.input) || {};
        if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) {
          throw new Error("retention months must be an integer between 1 and 60");
        }
        retentionMonths = input.months;
        return ok({ status: "saved", months: retentionMonths });
      }
      case "export_diagnostic_package": return ok({ status: "saved", path: "/tmp/agent-vitals-diagnostic-browser-mock.zip", upload_performed: false });
      // Shape: apps/desktop/src-tauri/src/lib.rs:1708 statistics_timezone_config (json!).
      case "statistics_timezone_config": return { status: "ok", timezone, system_timezone: timezone };
      case "ui_language_config": return { status: "ok", language: uiLanguage, has_preference: hasUiLanguagePreference };
      case "save_ui_language_config": {
        const language = args && args.language;
        if (!["system", "en", "zh-Hans"].includes(language)) throw new Error("unsupported UI language preference");
        uiLanguage = language;
        hasUiLanguagePreference = true;
        return { status: "saved", language };
      }
      case "save_statistics_timezone_config": {
        const next = String((args && args.timezone) || "").trim();
        if (!next) throw new Error("statistics timezone must be a non-empty IANA name");
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: next }).format();
        } catch (_) {
          throw new Error("unknown IANA statistics timezone: " + next);
        }
        timezone = next;
        return { status: "saved", timezone };
      }
      case "public_pricing_catalog_status": return { state: "ok", network_enabled: pricingNetworkEnabled, source_url: "https://example.invalid/pricing.json", source_version: "public-browser-mock", model_count: 7, last_success_at_ms: pricingLastSuccessAt };
      case "save_public_pricing_catalog_policy": {
        pricingNetworkEnabled = !!(args && args.networkEnabled);
        return { status: "saved", network_enabled: pricingNetworkEnabled };
      }
      case "update_public_pricing_catalog": {
        if (!pricingNetworkEnabled) throw new Error("公共价格联网检查未开启；继续使用本地价卡");
        pricingLastSuccessAt = Date.now();
        return { status: "updated", source_url: "https://example.invalid/pricing.json", source_version: "public-browser-mock", model_count: 7, last_success_at_ms: pricingLastSuccessAt };
      }
      case "about_diagnostics": return { status: "ok", app_version: "browser-mock", cli_version: "browser-mock", engine_version: "browser-mock", architecture: "browser-mock", authority_schema: "browser-mock", statistics_timezone: timezone, pricing: { version: "public-browser-mock", captured_at_ms: Date.now() - 3600000 }, sync: { ok: true, message: "浏览器样式调试数据" } };
      case "open_trusted_releases_page": {
        const requested = args && args.url;
        const trustedRoot = "https://github.com/Oh-Agent-AI/oh-agent/releases";
        const trustedTag = typeof requested === "string" && requested.startsWith(trustedRoot + "/tag/app-v") ? requested : null;
        return { status: "opened", url: trustedTag || trustedRoot, automatic_install: false };
      }
      case "restore_authority_backup": return { status: "cancelled" };
      case "check_for_updates": return { status: "ok", current_version: "browser-mock", latest_tag: "app-v1.0.0", update_available: true, release_url: "https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0", automatic_install: false };
      // Shape: apps/desktop/src-tauri/src/lib.rs:2776 quota_reminder_config() -> {status, enabled}
      // 用户补的价卡：{cards: {<provider>: {<model>: {input_uncached,input_cached,output}}}}，
      // 形状与 assets/pricing.json 的 providers 段同形。
      // Shape: apps/desktop/src-tauri/src/lib.rs:2816 price_cards()
      // 用户声明的型号归属：{<model_prefix>: {provider, mode}}。
      // Shape: apps/desktop/src-tauri/src/lib.rs:2861 price_routes()
      case "price_routes": return { status: "ok", routes: priceOverrideRoutes };
      case "save_price_route": {
        const input = (args && args.input) || {};
        if (!input.model_prefix || !input.provider_id) throw new Error("model_prefix and provider_id are required");
        if (!["metered", "subscription"].includes(input.mode)) throw new Error("mode must be metered or subscription");
        priceOverrideRoutes[input.model_prefix] = { provider: input.provider_id, mode: input.mode };
        return ok({ status: "saved", model_prefix: input.model_prefix, provider_id: input.provider_id });
      }
      case "delete_price_route": {
        delete priceOverrideRoutes[args && args.modelPrefix];
        return ok({ status: "removed" });
      }
      case "price_cards": return { status: "ok", cards: priceOverrideCards };
      // Shape: apps/desktop/src-tauri/src/lib.rs price_card_providers() -> {status, providers:[{id, currency|null, offered:[…]|null}]}
      // deepseek-official 有两套官方报价：没被自己的卡钉住时 currency 为 null、offered 给出可选币种。
      case "price_card_providers": return { status: "ok", providers: [
        { id: "anthropic", currency: "USD", offered: null }, { id: "moonshot", currency: "USD", offered: null },
        { id: "minimax", currency: "CNY", offered: null }, { id: "shengsuanyun", currency: "CNY", offered: null },
        { id: "deepseek-official", currency: null, offered: ["CNY", "USD"] },
      ] };
      // Shape: apps/desktop/src-tauri/src/lib.rs quote_variants_status() -> {status, providers:[{provider,label,active_currency,source,available,chosen_currency|null}]}
      case "quote_variants_status": return { status: "ok", providers: [
        { provider: "deepseek-official", label: "DeepSeek 原厂", active_currency: quoteChoice || "USD", source: quoteChoice ? "user_choice" : "default_assumption", available: ["CNY", "USD"], chosen_currency: quoteChoice },
      ] };
      case "save_quote_choice": quoteChoice = args && args.currency ? args.currency : null; return { status: "saved" };
      // Shape: apps/desktop/src-tauri/src/lib.rs official_price_card() -> {found, provider?, card_key?, rates?, currency?, reason?}
      case "official_price_card": return { found: false };
      case "save_price_card": {
        const input = (args && args.input) || {};
        if (!input.provider_id || !input.model_id) throw new Error("provider_id and model_id are required");
        (priceOverrideCards[input.provider_id] ||= {})[input.model_id] = {
          input_uncached: input.input_uncached, input_cached: input.input_cached, output: input.output,
          ...(input.cache_write ? { cache_write: input.cache_write } : {}),
        };
        return ok({ status: "saved", provider_id: input.provider_id, model_id: input.model_id });
      }
      case "delete_price_card": {
        const provider = priceOverrideCards[args && args.providerId];
        if (provider) delete provider[args && args.modelId];
        return ok({ status: "removed" });
      }
      case "quota_reminder_config": return { status: "ok", enabled: quotaReminderEnabled };
      case "save_quota_reminder_config": {
        quotaReminderEnabled = !!(args && args.enabled);
        return ok({ status: "saved", enabled: quotaReminderEnabled, notification_permission: "granted" });
      }
      // Claude Pro 的窗口状态：state:"unknown" -> {observed_at, windows_recent}；
      // state:"exhausted" -> 另有 {window, resets_at}。浏览器里给 exhausted
      // （演示"时间窗口"那一态）。**没有百分比字段**——数据里不存在正向余量
      // （真机 42/42 条 quotaLimits 全是 status:"rejected"）。
      // Shape: crates/agent-vitals-runtime/src/summary.rs:1407 claude_quota_status()
      case "data_claude_quota": return {
        state: "exhausted", window: "five_hour", window_label: "5 小时窗口",
        last_resets_at: Math.floor(Date.now() / 1000) - 3600, last_window: "five_hour",
        resets_at: Math.floor(Date.now() / 1000) + 3 * 3600,
        observed_at: new Date(Date.now() - 45 * 60000).toISOString(),
        windows_recent: 2,
      };
      // 形状出处：harnesses/codex/sessions/usage.rs plan_from_rate_limits →
      //   { plan_type, has_credits, limits: { primary: {...} }, observed_at }（事件的 ISO 时间戳）。
      // Shape: apps/desktop/src-tauri/src/lib.rs:2767 data_codex_quota → crates/agent-vitals-harnesses/src/harnesses/codex/sessions/usage.rs:191 plan_from_rate_limits.
      case "data_codex_quota": return { plan_type: "Plus", has_credits: false, limits: { primary: { used_percent: 38, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 7200 } }, observed_at: new Date(Date.now() - 1500000).toISOString() };
      // Shape: crates/agent-vitals-data/src/route_quality.rs:138-186.
      // 只放合成的模型族事实；credential_ref、endpoint、路径和原始日志不进入 mock。
      case "routes_quality": {
        const nowMs = Date.now();
        return {
          since_ms: nowMs - Number((args && args.days) || 90) * 86400000,
          now_ms: nowMs,
          families_vocabulary: ["anthropic", "openai", "deepseek", "glm", "minimax", "gemini", "qwen", "synthetic", "unknown"],
          harnesses: [{
            harness: "plugin:zcode", has_baseline: true, native_families: ["glm"], totals: { requests: 12, sessions: 3 },
            families: [
              { family: "glm", flag: "native", requests: 9, sessions: 3, tokens_total: 18000, last_event_ms: nowMs - 3600000, request_share: 75, models: [{ model: "glm-5", provider_raw: "zhipu", provider_id: "zhipu", requests: 9, tokens_total: 18000, last_event_ms: nowMs - 3600000 }] },
              { family: "deepseek", flag: "non_native", requests: 2, sessions: 1, tokens_total: 4200, last_event_ms: nowMs - 7200000, request_share: 16.7, models: [{ model: "bigmodel/deepseek-v4-flash[1M]", provider_raw: "relay", provider_id: "relay", requests: 2, tokens_total: 4200, last_event_ms: nowMs - 7200000 }] },
              { family: "synthetic", flag: "api_error", requests: 1, sessions: 1, tokens_total: 0, last_event_ms: nowMs - 10800000, request_share: 8.3, models: [{ model: "<synthetic>", provider_raw: "", provider_id: "", requests: 1, tokens_total: 0, last_event_ms: nowMs - 10800000 }] },
            ],
          }, {
            harness: "minimax-code", has_baseline: false, native_families: [], totals: { requests: 4, sessions: 2 },
            families: [{ family: "minimax", flag: "no_baseline", requests: 4, sessions: 2, tokens_total: 9000, last_event_ms: nowMs - 1800000, request_share: 100, models: [{ model: "MiniMax-M2", provider_raw: "", provider_id: "", requests: 4, tokens_total: 9000, last_event_ms: nowMs - 1800000 }] }],
          }],
        };
      }
      case "sessions_list": {
        const cursor = args && args.cursor;
        // City 预览：大页请求按游标分页给合成数据（每页 500，与真机分页同构）。
        // order=oldest 与真机同语义：first_event 升序——预览里也能看到「从最老
        // 数据开始分页」的懒加载叙事。
        if ((args && (args.pageSize ?? args.page_size)) >= 100 || /^city-page-\d+$/.test(String(cursor))) {
          const ordered = args && args.order === "oldest"
            ? [...citySessions].sort((left, right) => Date.parse(left.first_event_at) - Date.parse(right.first_event_at))
            : citySessions;
          const pageIndex = cursor ? Number(String(cursor).slice("city-page-".length)) : 0;
          const slice = ordered.slice(pageIndex * 500, pageIndex * 500 + 500);
          if (!slice.length) return { data: { sessions: [], next_cursor: null, has_more: false, window_session_count: citySessions.length, window_total_tokens: 0 } };
          const next = (pageIndex + 1) * 500 < ordered.length ? `city-page-${pageIndex + 1}` : null;
          return { data: { sessions: slice, next_cursor: next, has_more: next !== null, window_session_count: citySessions.length, window_total_tokens: citySessions.reduce((sum, session) => sum + session.tokens.total, 0) } };
        }
        // 一页一条：第一页 → preview-next → preview-next-2（第三页是「订阅为主 + 缺价」样例）
        const pageIndex = cursor === "preview-next-2" ? 2 : cursor ? 1 : 0;
        const page = sessions.slice(pageIndex, pageIndex + 1);
        const next = pageIndex + 1 < sessions.length ? (pageIndex === 0 ? "preview-next" : "preview-next-2") : null;
        return { data: { sessions: page, next_cursor: next, has_more: next !== null, window_session_count: sessions.length, window_total_tokens: sessions.reduce((sum, session) => sum + session.tokens.total, 0) } };
      }
      case "session_trace": {
        // Synthetic preview only; production invokes the existing local authority.
        // 形状出处：crates/agent-vitals-domain/src/domain/session_insights.rs::build_insights
        // + crates/agent-vitals-query/src/query/session_insights.rs::session_insights。
        if (args.output === "insights") {
          const index = sessions.findIndex((session) => session.session_ref === (args && args.sessionRef));
          const cityIndex = citySessions.findIndex((session) => session.session_ref === (args && args.sessionRef));
          const session = cityIndex >= 0 ? citySessions[cityIndex] : sessions[Math.max(0, index)];
          return { data: mockInsights(session.harness, cityIndex >= 0 ? 60 : index === 1 ? 420 : 40) };
        }
        if (args.output === "graph") return { data: { coverage: { total_nodes: 9, total_edges: 8, missing_parent: 0, missing_time: 0, missing_status: 0 } } };
        return { data: {
          linearization: "leaf",
          points: [2, 4, null, 1, 5, 3].map((value, index) => ({ ordinal: index, task_id: String(index + 1), values: { tool_call_count: value } })),
          series: [{ name: "tool_call_count", cumulative: false }],
          events: [{ ordinal: 1, kind: "tool", label: "工具调用", severity: "info" }, { ordinal: 4, kind: "risk", label: "工具失败", severity: "critical" }],
          unplaced_events: 1,
        } };
      }
      case "session_trace_evidence": {
        // 形状出处：crates/agent-vitals-query/src/query/session_insights.rs::session_trace_evidence。
        const from = args.from, to = args.to;
        const calls = [], failures = [], safety = [];
        for (let step = from; step <= to && step <= 420; step += 1) {
          if (step === 25) continue;
          for (let k = 0; k < 3 && args.includeCalls !== false; k += 1) calls.push({ step, ts_ms: 1789000000000 + step * 120000 + k * 9000, model_id: step < 30 ? "claude-sonnet-5" : "claude-opus-5-5", input: { cache_read: 30000 + step * 900, cache_write: step >= 12 && step <= 14 ? 22000 : 400, uncached_input: step >= 12 && step <= 14 ? 9000 : 300 }, output: 900 });
          if (step >= 18 && step <= 20) failures.push({ step, ts_ms: 1789000000000 + step * 120000 + 5000, capability_id: "Bash", invocation_key: "fnv1a64:preview", error_excerpt: "Error: Cannot find module 'vitest/config'", args_excerpt: '{"command":"npx vitest run"}' });
        }
        if (from <= 7 && to >= 7) safety.push({ rule: "SV601", severity: "critical", step: 7, tool: "bash", summary: "rm -rf ./dist-old" });
        return { data: { steps: { from, to }, calls, failures, safety, local_only: true } };
      }
      case "sessions_read": {
        const selected = sessions.find((session) => session.session_ref === (args && args.sessionRef)) || citySessions.find((session) => session.session_ref === (args && args.sessionRef)) || sessions[0];
        const model = selected.model_ids[0] || "<unknown>";
        const tokens = selected.tokens;
        return { data: {
          ...selected,
          billing_breakdown: mockBillingBreakdowns[selected.session_ref] ? mockBillingBreakdowns[selected.session_ref].map(([model_id, billing_mode, total]) => ({ provider_id: "openai", provider_raw: "openai", model_id, billing_template_id: null, billing_mode, pricing_basis: "metered_estimate", evidence_basis: "missing", pricing_version: "preview-v1", pricing_source: null, cost_minor: null, peak: false, tokens: { uncached_input_tokens: 0, cache_read_tokens: total, cache_write_tokens: 0, output_tokens: 0, total }, has_unresolved: billing_mode !== "subscription", unresolved_reason: billing_mode === "subscription" ? "subscription token usage is not a per-token bill" : "no compatible price card for this provider/model bucket" })) : [{ provider_id: selected.harness === "codex" ? "openai" : "<unknown>", provider_raw: selected.harness === "codex" ? "openai" : null, model_id: model, billing_template_id: null, billing_mode: selected.cost_status.state === "subscription" ? "subscription" : "metered", pricing_basis: selected.cost_minor?.basis || "unavailable", evidence_basis: selected.cost_status.has_unresolved ? "missing" : "explicit-official-route", pricing_version: selected.cost_minor ? "preview-v1" : null, pricing_source: selected.cost_minor ? "official" : null, cost_minor: selected.cost_minor, peak: true, tokens, has_unresolved: selected.cost_status.has_unresolved, unresolved_reason: selected.cost_status.has_unresolved ? "no pricing snapshot covers this event time" : null }],
          timeline: [{ event_at: selected.first_event_at, model_id: model, observation_kind: "assistant-usage", peak: false, tokens: { uncached_input_tokens: tokens.uncached_input_tokens, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: tokens.uncached_input_tokens } }, { event_at: selected.last_event_at, model_id: model, observation_kind: "assistant-usage", peak: true, tokens: { uncached_input_tokens: 0, cache_read_tokens: tokens.cache_read_tokens, cache_write_tokens: tokens.cache_write_tokens, output_tokens: tokens.output_tokens, total: tokens.cache_read_tokens + tokens.cache_write_tokens + tokens.output_tokens } }],
          workflow_timeline: [{ event_at: selected.last_event_at, event_type: "tool_finished", capability_kind: "tool", capability_id: "bash", capability_version: null, outcome: "succeeded", duration_ms: 1400, error_fingerprint: null, invocation_fingerprint: null }],
          workflow_has_more: false, has_more: false, next_cursor: null,
        } };
      }
      case "sessions_issues": return {
        totals: { issues: issueGroups.length, findings: issueGroups.length, critical: 0, warning: issueGroups.length, info: 0, sessions: 1, sessions_total: 1 },
        rules: issueGroups.map((group) => ({ rule: group.rule, severity: group.severity, category: group.category, hits: group.hits, sessions: group.sessions })),
        issues: issueGroups, findings: [], source: "browser_mock", next_cursor: null, source_projection_count: 1,
      };
      case "findings_groups_safe": {
        const findingNow = Date.now();
        return {
        schema_version: "agent-vitals-findings/v1", status: "ok",
        totals: { issues: 2, findings: 2, critical: 1, warning: 1, info: 0, sessions: 2, sessions_total: 2 },
        rules: [
          { rule: "SV709", severity: "critical", category: "behavior", hits: 1, sessions: 1 },
          { rule: "PRICE_COVERAGE", severity: "warning", category: "billing", hits: 1, sessions: 1 },
        ],
        issues: [
          { group_id: "fnv1a64:0123456789abcdef", action_kind: "behavior", rule: "SV709", harness: "plugin:zcode", evidence_class: "egress", count: 1, first_seen_at_ms: findingNow - 7200000, last_seen_at_ms: findingNow - 3600000, severity: "critical", status_rollup: { open: 1, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 }, sessions_count: 1, sample_evidence: [{ available: true, reference: "fnv1a64:2222222222222222", observed_first_at_ms: findingNow - 7200000, observed_last_at_ms: findingNow - 3600000, evidence_level: "E3", stage: "egress_attempted", evidence_origin: "network_metadata", scope_classes: ["git_history", "workspace_archive"], observation_count: 2, file_count: null, byte_count: 3145728, destination_class: "object_storage", confidence: "high" }], read_only: true, manual_follow_up: false },
          { group_id: "fnv1a64:1111111111111111", action_kind: "billing", rule: "PRICE_COVERAGE", harness: "minimax-code", evidence_class: "billing", count: 1, first_seen_at_ms: findingNow - 1800000, last_seen_at_ms: findingNow - 1800000, severity: "warning", status_rollup: { open: 1, later: 0, acknowledged: 0, resolved: 0, not_applicable: 0 }, sessions_count: 1, sample_evidence: [{ available: true, reference: "fnv1a64:3333333333333333", observed_first_at_ms: findingNow - 1800000, observed_last_at_ms: findingNow - 1800000, evidence_level: null, stage: null, evidence_origin: "local_artifact", scope_classes: [], observation_count: 1, file_count: null, byte_count: null, destination_class: null, confidence: "medium" }], read_only: false, manual_follow_up: true },
        ],
        next_cursor: null, refreshed: false,
        };
      }
      case "findings_freshness": return { status: "ok", freshness: { state: "stale", last_successful_sync_at: new Date(Date.now() - 1500000).toISOString(), stale_harnesses: ["workbuddy"], syncing: false } };
      case "trust_monitor_config": return { ...trustMonitorConfig };
      case "trust_evidence_read": return { harness: args && args.harness || null, count: 0, evidence: [], next_cursor: null, source: "browser_mock" };
      case "trust_discover": return { candidates: [{ id: "sample-agent", detected: true, artifact_profile_available: true, coverage_state: "profiled" }], profile_errors: [] };
      case "trust_profile_proposal_status": return { status: "ok", authority_state: "ready", data: { pending: trustProfileState.pending, approved: trustProfileState.approved, history: [] } };
      case "trust_profile_approve": {
        const index = trustProfileState.pending.findIndex((profile) => profile.slug === (args && args.slug) && profile.manifest_hash === (args && args.manifestHash));
        if (index < 0) throw new Error("proposal changed");
        const [profile] = trustProfileState.pending.splice(index, 1);
        profile.state = "approved";
        trustProfileState.approved.push(profile);
        return { status: "ok", data: { status: "approved", slug: profile.slug, manifest_hash: profile.manifest_hash } };
      }
      case "trust_profile_reject": {
        const index = trustProfileState.pending.findIndex((profile) => profile.slug === (args && args.slug) && profile.manifest_hash === (args && args.manifestHash));
        if (index < 0) throw new Error("proposal changed");
        const [profile] = trustProfileState.pending.splice(index, 1);
        return { status: "ok", data: { status: "rejected", slug: profile.slug } };
      }
      case "trust_profile_revoke": {
        const index = trustProfileState.approved.findIndex((profile) => profile.slug === (args && args.slug) && profile.manifest_hash === (args && args.manifestHash));
        if (index < 0) throw new Error("profile changed");
        const [profile] = trustProfileState.approved.splice(index, 1);
        return { status: "ok", data: { status: "revoked", slug: profile.slug } };
      }
      case "trust_suppression_list": return { status: "ok", suppressions: trustSuppressions };
      case "trust_suppression_create": {
        const issueType = args && args.issueType;
        if (!/^SV70[1-9]$|^SV710$/.test(issueType)) throw new Error("unknown Trust Finding type");
        const suppressionId = `trust-suppression-${issueType}-${Date.now()}`;
        trustSuppressions.unshift({ suppression_id: suppressionId, issue_type: issueType, created_at_ms: Date.now(), revoked_at_ms: null });
        return { status: "saved", suppression_id: suppressionId };
      }
      case "trust_suppression_revoke": {
        const row = trustSuppressions.find((item) => item.suppression_id === (args && args.suppressionId));
        if (!row || row.revoked_at_ms !== null) return { status: "not_found", suppression_id: args && args.suppressionId };
        row.revoked_at_ms = Date.now();
        return { status: "revoked", suppression_id: row.suppression_id };
      }
      case "save_trust_monitor_config": {
        const enabled = !!(args && args.enabled);
        const interval = Number(args && args.intervalSeconds);
        if (!Number.isSafeInteger(interval) || interval < 5 || interval > 3600) throw new Error("interval_seconds must be between 5 and 3600");
        trustMonitorConfig.enabled = enabled;
        trustMonitorConfig.interval_seconds = interval;
        trustMonitorConfig.notifications_enabled = enabled && !!(args && args.notificationsEnabled);
        trustMonitorConfig.capability = enabled ? "partial" : "not_started";
        trustMonitorConfig.updated_at_ms = Date.now();
        trustMonitorConfig.notification_permission = trustMonitorConfig.notifications_enabled ? "granted" : null;
        return { ...trustMonitorConfig };
      }
      case "trust_runtime_snapshot": {
        trustMonitorConfig.last_success_at_ms = Date.now();
        trustMonitorConfig.capability = "partial";
        trustMonitorConfig.updated_at_ms = Date.now();
        return { ...trustSnapshot };
      }
      // Shape: crates/agent-vitals-runtime/src/decision_matrix.rs::decision_matrix
      // （rows 键 = combo_rows 的 json! 字段；金额按币种分列，mock 同纪律）。
      case "decision_matrix_safe": return {
        schema_version: "agent-vitals-decision-matrix/v1", status: "ok", month: "2026-09",
        rows: [{ harness: "plugin:zcode", model_id: "glm-5", provider_id: "zhipu", sessions: 4,
          tokens: { uncached_input: 1200, cache_read: 8800, cache_write: 300, output: 900, total: 11200 },
          cache_hit_ratio: 0.8544, has_subscription: false, waste_rate: null,
          amounts: [{ amount_minor: 781, currency: "CNY", basis: "metered_estimate" }],
          top_sessions: [{ session_ref: "sr_0123456789", span_first_ms: Date.now() - 3600000, span_last_ms: Date.now(), tokens_total: 6400, failures: 2 }],
          harness_behavior: { SV610: 2 }, limit_pressure: { hits: 1, per_session: 0.25 }, cost_provider_unresolved: false }],
        findings_summary: [{ kind: "marathon", session_ref: "sr_0123456789", span_hours: 25.2, tokens_total: 11200, failures: 2, combo: { harness: "plugin:zcode", model_id: "glm-5" } }],
        limitations: ["waste_rate_unavailable", "harness_behavior_harness_level", "amounts_currency_separated", "fingerprint_link_deferred"],
      };
      case "decision_matrix": return {
        month: "2026-09",
        rows: [
          { harness: "codex", model_id: "gpt-6-astra", provider_id: "cogfoundry.ai", sessions: 10,
            tokens: { uncached_input: 2, cache_read: 3, cache_write: 1, output: 1, total: 7 },
            cache_hit_ratio: 0.5, has_subscription: false, waste_rate: null,
            amounts: [], cost_provider_unresolved: false, top_sessions: [], harness_behavior: {} },
          { harness: "codex", model_id: "gpt-5.6-terra", provider_id: "shengsuanyun", sessions: 31,
            tokens: { uncached_input: 1754, cache_read: 34448965, cache_write: 2304878, output: 119195, total: 36875892 },
            cache_hit_ratio: 0.9363, has_subscription: false, waste_rate: null,
            amounts: [{ amount_minor: 1408, currency: "USD", basis: "metered_estimate" }],
            cost_provider_unresolved: true, top_sessions: [], harness_behavior: { SV610: 62, SV607: 8 } },
          { harness: "claude-code", model_id: "deepseek-v4-flash-0731", provider_id: "<unknown>", sessions: 12,
            tokens: { uncached_input: 44432002, cache_read: 12596736, cache_write: 0, output: 13030, total: 57041768 },
            cache_hit_ratio: 0.2211, has_subscription: false, waste_rate: null,
            amounts: [{ amount_minor: 6734, currency: "CNY", basis: "metered_estimate" }],
            cost_provider_unresolved: true,
            top_sessions: [{ session_ref: "sr_1f7589ece7184a8a8a9bb0c", span_first_ms: Date.now() - 179000000, span_last_ms: Date.now(), tokens_total: 473030189 }],
            harness_behavior: {} },
          { harness: "claude-code", model_id: "glm-5.3", provider_id: "zhipu-glm", sessions: 3,
            tokens: { uncached_input: 1, cache_read: 2, cache_write: 0, output: 0, total: 3 },
            cache_hit_ratio: null, has_subscription: true, waste_rate: null,
            amounts: [], cost_provider_unresolved: false, top_sessions: [], harness_behavior: {} },
        ],
        notes: ["waste_rate 恒 null：waste 检测器仅 DSH 且尚未接入（spec §4.2，不用 0 冒充）"],
      };
      case "issue_group_instances": return { group_id: args && args.groupId, instances: issueInstances, next_cursor: null, total_instances: issueInstances.length };
      case "issue_instance_read": return { status: "ok", issue: issueInstances.find((item) => item.issue_id === (args && args.issueId)) || null };
      case "issue_transition": return transitionIssue(args && args.issueId, args && args.toStatus);
      case "source_read_locations": return { status: "ok", locations: { codex: "~/.codex", "claude-code": "~/.claude", dsh: "~/.deepseek" } };
      case "sync_pause_state": return { status: "ok", paused: syncPaused };
      case "peek_nav_target": case "peek_focus_target": return null;
      case "sync_request_status": return { completed: true };
      case "trigger_sync": {
        for (const source of sourceStatuses) {
          if (source.connection_state === "needs_attention") {
            source.connection_state = "connected";
            source.failed_scope = {};
            source.recovery_action = null;
          }
        }
        return "browser-mock-sync";
      }
      case "set_sync_paused":
        syncPaused = !!(args && args.paused);
        return ok({ status: "ok", paused: syncPaused });
      case "set_source_harness_excluded": {
        const input = (args && args.input) || {};
        const source = sourceStatuses.find((item) => item.harness === input.harness);
        if (!source) throw new Error("source harness not found");
        source.connection_state = input.excluded ? "excluded" : "connected";
        source.failed_scope = input.excluded ? {} : source.failed_scope;
        source.recovery_action = input.excluded
          ? { label: "恢复读取", kind: "include_source" }
          : null;
        return ok({ status: "ok", harness: source.harness, excluded: !!input.excluded });
      }
      case "delete_imported_source_data": {
        const source = sourceStatuses.find((item) => item.harness === (args && args.harness));
        if (!source) throw new Error("source harness not found");
        const scope = source.import_scope || {};
        const result = { status: "deleted", harness: source.harness, facts: Number(scope.facts || 0), sessions: Number(scope.sessions || 0), source_files: Number((source.scan && source.scan.source_count) || 0), trust_observations: 0, route_evidence: 0, session_excerpts: 0 };
        source.import_scope = { facts: 0, sessions: 0 };
        source.connection_state = "excluded";
        sourceDataRevision += 1;
        return ok(result);
      }
      case "pick_custom_source_root": return "/tmp/agent-vitals-browser-custom-source";
      case "add_custom_source_root": {
        const input = (args && args.input) || {};
        if (!input.harness || !input.root) throw new Error("custom source harness and root are required");
        const exists = customRoots.some((item) => item.harness === input.harness && item.root === input.root);
        if (!exists) customRoots.push({ harness: input.harness, root: input.root });
        return ok({ status: "ok", changed: !exists });
      }
      case "remove_custom_source_root": {
        const input = (args && args.input) || {};
        const index = customRoots.findIndex((item) => item.harness === input.harness && item.root === input.root);
        if (index >= 0) customRoots.splice(index, 1);
        return ok({ status: "ok", changed: index >= 0 });
      }
      case "harness_display_names": return { ...cityHarnessNames, workbuddy: "WorkBuddy" };
      case "clear_nav_target": case "clear_focus_target": return ok({ status: "ok" });
      // 测试板 IP 自检：浏览器预览不跑真实网络探测（探测收敛在应用进程），给一份
      // TEST-NET 合成报告，保证布局/降级态可开发可验证。
      case "ip_check_run": return {
        proxy_mode: "direct",
        claude: { ip: "203.0.113.7", colo: "SYN", loc: "SG", warp: "off" },
        cloudflare: { ip: "203.0.113.7", colo: "SIN", loc: "SG", warp: "off" },
        china: { ip: "198.51.100.23", location: "中国 · 上海 · 上海" },
        dns: { ip: "203.0.113.7", geo: "Singapore - Mock Resolver" },
        intel: { country: "Singapore", countryCode: "SG", regionName: "", city: "Singapore", isp: "MockNet", org: "MockNet", as: "AS64512 MockNet", mobile: false, proxy: true, hosting: true },
        latency: [
          { host: "claude.ai", ms: 128, ok: true },
          { host: "www.anthropic.com", ms: 311, ok: true },
        ],
        stun: { ip: "203.0.113.7" },
      };
        default: throw new Error("Unsupported browser mock command: " + command);
      }
    } catch (error) {
      console.error("[browser-mock] invoke failed", command, error);
      throw error;
    }
  }

  window.__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
    notification: null,
  };

  // City 插件的浏览器预览数据源（browser-plugin-host.js 经 __AV_BROWSER_PROVIDERS__.city 转发）。
  // City 迁成插件后这里一直缺席：网页预览的 City 只显示「数据暂不可用」，岛屿种子也存不了。
  // 复用上面的 citySessions（700 条确定性模拟会话），按真实宿主的 city:v2 形状返回；种子存 localStorage。
  const cityHarnessId = (harness) => (harness === "plugin:zcode" ? "harness:zcode" : harness);
  const cityHarnessNames = { codex: "Codex", "claude-code": "Claude Code", "harness:zcode": "ZCode", dsh: "DeepSeek Harness" };
  // 显式注入的测试/预览 provider 优先，默认演示数据不能覆盖调用方。
  window.__AV_BROWSER_PROVIDERS__ = Object.assign({
    city: async (request) => {
      const payload = request.payload || {};
      if (request.method !== "data.read") throw new Error("unsupported_method");
      if (payload.projection === "city-settings") {
        // 预览默认固定一个有河的岛（没有种子时插件会随机抽，约 18% 的种子设计上无河，
        // 预览里看不到河曾被当成回归）。用「重新生成岛屿」写入的新种子仍会被记住。
        if (payload.action === "write" && Number.isInteger(payload.seed)) localStorage.setItem("city.preview-seed", String(payload.seed));
        const saved = Number(localStorage.getItem("city.preview-seed"));
        return { seed: Number.isInteger(saved) && saved > 0 && saved <= 4294967295 ? saved : 1703294958 };
      }
      if (payload.projection !== "city") throw new Error("unsupported_projection");
      const days = [7, 30, 90, 366].includes(payload.windowDays) ? payload.windowDays : 30;
      const now = Date.now();
      const from = now - days * 86400000;
      const inWindow = citySessions
        .filter((session) => Date.parse(session.last_event_at) >= from)
        .sort((left, right) => Date.parse(left.first_event_at) - Date.parse(right.first_event_at));
      const sessions = inWindow.map((session) => ({
        id: session.session_ref, harness: cityHarnessId(session.harness),
        first_event_at: session.first_event_at, last_event_at: session.last_event_at, event_count: session.event_count,
        tokens: { input: session.tokens.total - session.tokens.output_tokens, output: session.tokens.output_tokens, total: session.tokens.total },
        task_excerpts: [],
      }));
      return {
        protocol: "city:v2", source: "fixture", data_revision: 1,
        harnesses: Object.entries(cityHarnessNames).map(([id, display_name]) => ({ id, display_name,
          capabilities: { session_statistics: { available: true }, findings: { available: id !== "harness:zcode", reason: id === "harness:zcode" ? "findings_not_supported" : null } } })),
        generated_at: new Date(now).toISOString(),
        window: { days, label: `最近 ${days} 天`, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
        coverage: { total: sessions.length, returned: sessions.length, truncated: false, unknown_time: 0, findings_state: "partial" },
        status: sessions.length ? "ready" : "empty", sessions,
        findings: [{ harness: "codex", severity: "warning", count: 3 }, { harness: "claude-code", severity: "info", count: 2 }],
      };
    },
  }, window.__AV_BROWSER_PROVIDERS__ || {});
})();
