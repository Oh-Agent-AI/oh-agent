import { DetMath as Math } from "./engine/detMath"; // 跨引擎确定性：见 engine/detMath.ts
/**
 * City 模型层：把 Agent Vitals 的业务数据（Session / Harness / Token / Finding / 时间）
 * 映射成一座"数据城市"的中性模型。本文件不依赖任何渲染库——三维引擎只消费
 * 这里产出的 `CityModel`，未来更换 Renderer 时数据语义保持不变。
 *
 * 映射约定（SIMULATE THE DATA, FAKE THE CITY）：
 *   Session → 建筑          （1 个 session = 1 栋楼；超过渲染上限的聚合为背景楼群）
 *   Harness    → 城市          （每个 harness 一座岛/区，建筑风格 = harness 配色与立面语言）
 *   Token   → 建筑材料/规模  （对数映射到高度与体量）
 *   Progress→ 施工进度      （会话关闭 = 封顶；活跃会话 = 工地，完成度为估算值）
 *   Finding → 区域异常      （finding 只到 harness 粒度，因此在 harness 区上标记，不落到具体楼）
 *   Time    → 生长与 Replay （first_event 决定楼在时间轴上的出现时刻）
 */

export type CitySessionRow = {
  session_ref: string;
  /** Stable City asset id (`ca_` + 32 hex) from city:v3. Used to join MCP building overrides. */
  asset_ref?: string | null;
  harness: string;
  /** 会话标题（V32 楼名）：codex thread_name / claude ai-title / dsh workspace
   *  title 的脱敏截断投影；null = 无标题证据（面板走 harness + 日期 fallback）。 */
  title: string | null;
  /** 标题来源（codex_thread_name | claude_ai_title | dsh_workspace_title）。 */
  title_source: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  event_count: number;
  model_ids: string[];
  tokens: { uncached_input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; total: number };
  peak_tokens: number;
  cost_minor: { amount_minor: number; currency: string; basis: "metered_actual" | "metered_estimate" | "fixed_subscription" | "api_equivalent" | "other" } | null;
  cost_status: { state: "estimated" | "subscription" | "unpriced" | "unavailable"; reason: string; has_unresolved: boolean };
};

export type CityFindingGroup = {
  harness: string;
  rule: string;
  severity: string;
  status_rollup: { open: number; later: number };
};

/** 会话被视为"正在施工"的窗口：last_event 距今 10 分钟内。
 *  仅用于挑选「已收工」样本算 p95 楼高标尺；「活跃」的定义见 isActiveToday。 */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

/** 活跃 = 今天（本机本地日）有过事件——与菜单栏「N sessions」同一口径。
 *  曾是「last_event 距今 10 分钟内」：City 显示 0 active，而菜单栏同时显示今天 2 个 session（真机截图），
 *  两处说的不是一件事。本地日界与菜单栏一致（宿主 today 按本地时区切日）。 */
export function startOfLocalDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
export function isActiveToday(lastEventMs: number, generatedAt: number): boolean {
  return lastEventMs >= startOfLocalDay(generatedAt) && lastEventMs <= generatedAt + 60_000;
}

/** 单独成楼的 session 上限；超出部分按区聚合为背景楼群（massing）。 */
// 与宿主 SESSION_CAP 同为 4000：载入的每个会话都能单独成楼（岛 1 档 2000 栋、2 档扩到 4000 栋）。
export const RENDER_CAP = 4_000;
// 数据装载上限不在这里：宿主查询 `crates/agent-vitals-query/src/query/app_local.rs::SESSION_CAP`（最近 500 条）
// 是唯一真相源，UI 只显示宿主回报的 coverage.returned/total。曾在此留一个从未被引用的 LOAD_CAP = 4_500，
// 与界面文案「最多 500 条」互相矛盾（CITY_DATA_LEGIBILITY_SPEC P6）。

export type BuildingArchetype = "tower" | "slab" | "midrise" | "block" | "landmark";

export type CityBuilding = {
  /** session_ref；聚合楼为 `fill:<harness>:<n>`。 */
  id: string;
  /** city:v3 `asset_ref` when this occupant is a real session (not a fill). */
  assetRef?: string;
  districtId: string;
  archetype: BuildingArchetype;
  /** 立面变体 0..2（punched / banded / glass），由 harness 风格与 seed 决定。 */
  facade: number;
  /** session_ref 的确定性哈希 → 外观抖动，刷新不重排。 */
  seed: number;
  /** 建筑材料量：session 总 token（聚合楼为成员之和）。 */
  tokensTotal: number;
  /** 封顶高度（世界单位），由 token 对数映射。 */
  height: number;
  footprint: number;
  startedAt: number;
  endedAt: number | null;
  /** 活跃会话：仍在施工。 */
  active: boolean;
  /** 当前完成度估算 [0,1]；关闭会话恒为 1。 */
  builtFraction: number;
  /** 施工繁忙度 [0,1]：近期 token 吞吐，驱动吊车节奏。 */
  busyness: number;
  /** 聚合背景楼：代表 extraCount 个未单独成楼的 session。 */
  aggregated: boolean;
  extraCount: number;
};

export type DistrictAnomaly = {
  severity: "critical" | "warning" | "info";
  count: number;
  topRule: string;
};

export type CityDistrict = {
  id: string;
  label: string;
  /** 该区真实 session 数（含被聚合部分）。 */
  sessionCount: number;
  tokensTotal: number;
  activeCount: number;
  anomaly: DistrictAnomaly | null;
};

export type CityModel = {
  generatedAt: number;
  windowStartMs: number;
  windowEndMs: number;
  windowLabel: string;
  districts: CityDistrict[];
  buildings: CityBuilding[];
  stats: {
    renderedSessions: number;
    aggregatedSessions: number;
    totalSessions: number;
    tokensTotal: number;
    activeCount: number;
    truncated: boolean;
  };
  /** 楼 id → 应用投影中的会话摘要（聚合楼无条目）。 */
  rows: Map<string, CitySessionRow>;
};

/** FNV-1a：稳定、无依赖。 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

const FAMILY_MATCHERS: Array<[RegExp, string]> = [
  [/claude|anthropic/i, "anthropic"],
  [/gpt|o[134](-|$)|openai/i, "openai"],
  [/deepseek/i, "deepseek"],
  [/glm|zhipu/i, "glm"],
  [/minimax/i, "minimax"],
  [/gemini/i, "gemini"],
  [/qwen/i, "qwen"],
];

export function modelFamily(modelIds: string[]): string {
  for (const model of modelIds) {
    for (const [pattern, family] of FAMILY_MATCHERS) {
      if (pattern.test(model)) return family;
    }
  }
  return "unknown";
}

/** Token → 高度：对数幂曲线，1e3→3.4 / 1e5→15.8 / 1e7→38.6。
 * Street-scale height preserves token ordering while keeping mid-rise neighborhoods legible. */
export function tokensToHeight(tokens: number): number {
  const magnitude = Math.max(0, Math.log10(Math.max(tokens, 1)) - 1);
  return Math.min(48, Math.max(2.6, 0.75 * Math.pow(magnitude, 2.2)));
}

function archetypeFor(seed: number, height: number, landmark: boolean): BuildingArchetype {
  if (landmark) return "landmark";
  if (height >= 30) return seed < 0.55 ? "tower" : "slab";
  if (height >= 14) return seed < 0.4 ? "slab" : seed < 0.78 ? "midrise" : "tower";
  return seed < 0.62 ? "midrise" : "block";
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 240_000;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function parseMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function anomalyFromFindings(groups: CityFindingGroup[]): DistrictAnomaly | null {
  let critical = 0;
  let warning = 0;
  let info = 0;
  let topRule = "";
  let topRank = -1;
  for (const group of groups) {
    const open = group.status_rollup.open + group.status_rollup.later;
    if (open <= 0) continue;
    const rank = group.severity === "critical" ? 3 : group.severity === "warning" ? 2 : 1;
    if (rank === 3) critical += open;
    else if (rank === 2) warning += open;
    else info += open;
    if (rank > topRank) {
      topRank = rank;
      topRule = group.rule;
    }
  }
  const count = critical + warning + info;
  if (!count) return null;
  return { severity: critical ? "critical" : warning ? "warning" : "info", count, topRule };
}

export type CityModelInput = {
  harnessNames?: Record<string, string>;
  rows: CitySessionRow[];
  findings: CityFindingGroup[];
  windowStartMs: number;
  windowEndMs: number;
  windowLabel: string;
  /** 窗口内真实 session 总数（服务端计数），用于岛体量规划。 */
  totalSessions: number;
  truncated: boolean;
  generatedAt?: number;
};

export function buildCityModel(input: CityModelInput): CityModel {
  const generatedAt = input.generatedAt ?? Date.now();
  const byHarness = new Map<string, CitySessionRow[]>();
  for (const row of input.rows) {
    const list = byHarness.get(row.harness);
    if (list) list.push(row);
    else byHarness.set(row.harness, [row]);
  }

  const findingsByHarness = new Map<string, CityFindingGroup[]>();
  for (const group of input.findings) {
    const list = findingsByHarness.get(group.harness);
    if (list) list.push(group);
    else findingsByHarness.set(group.harness, [group]);
  }

  // 全城 token 排名（landmark 依据）与各区已关闭会话的 P95（progress 估算基准）。
  const tokenSortedAll = input.rows.map((row) => row.tokens.total).sort((left, right) => left - right);
  const landmarkThreshold = percentile(tokenSortedAll, Math.max(0, 1 - 12 / Math.max(tokenSortedAll.length, 1)));

  const buildings: CityBuilding[] = [];
  const districts: CityDistrict[] = [];
  const rowsIndex = new Map<string, CitySessionRow>();
  let aggregatedSessions = 0;

  const harnessIds = [...byHarness.keys()].sort((left, right) => {
    const leftTokens = byHarness.get(left)!.reduce((sum, row) => sum + row.tokens.total, 0);
    const rightTokens = byHarness.get(right)!.reduce((sum, row) => sum + row.tokens.total, 0);
    return rightTokens - leftTokens;
  });

  // 单独成楼的配额：总数不超过 RENDER_CAP 时人人有楼；超过才按各执行环境会话数比例分（最大余数法）。
  // 曾按执行环境个数均分（1400/N）：5 个执行环境时每个只有 280 栋，会话多的执行环境大半被聚合。
  const totalRows = input.rows.length;
  const quotaOf = new Map<string, number>();
  if (totalRows <= RENDER_CAP) for (const id of harnessIds) quotaOf.set(id, byHarness.get(id)!.length);
  else {
    const exact = harnessIds.map((id) => ({ id, value: (byHarness.get(id)!.length / totalRows) * RENDER_CAP }));
    for (const item of exact) quotaOf.set(item.id, Math.floor(item.value));
    let left = RENDER_CAP - [...quotaOf.values()].reduce((sum, value) => sum + value, 0);
    for (const item of [...exact].sort((a, b) => (b.value - Math.floor(b.value)) - (a.value - Math.floor(a.value)) || (a.id < b.id ? -1 : 1))) {
      if (left <= 0) break;
      quotaOf.set(item.id, quotaOf.get(item.id)! + 1); left -= 1;
    }
  }

  for (const harnessId of harnessIds) {
    const harnessRows = byHarness.get(harnessId)!;
    // 时间序（老 → 新）：城市由内向外生长。
    harnessRows.sort((left, right) => parseMs(left.first_event_at, 0) - parseMs(right.first_event_at, 0));
    const closedTokens = harnessRows
      .filter((row) => generatedAt - parseMs(row.last_event_at, generatedAt) > ACTIVE_WINDOW_MS)
      .map((row) => row.tokens.total)
      .sort((left, right) => left - right);
    const p95 = closedTokens.length >= 8 ? percentile(closedTokens, 0.95) : Math.max(percentile(tokenSortedAll, 0.95), 1);

    const perHarnessQuota = quotaOf.get(harnessId) ?? harnessRows.length;
    const rendered = harnessRows.slice(0, perHarnessQuota);
    const overflow = harnessRows.slice(perHarnessQuota);
    let districtActive = 0;

    for (const row of rendered) {
      const startedAt = parseMs(row.first_event_at, input.windowStartMs);
      const endedAt = parseMs(row.last_event_at, startedAt);
      const active = isActiveToday(endedAt, generatedAt);
      if (active) districtActive += 1;
      const seed = hashSeed(row.session_ref);
      const height = tokensToHeight(row.tokens.total);
      const landmark = row.tokens.total >= landmarkThreshold && row.tokens.total > 0;
      const finalHeight = landmark ? height * 1.12 : height;
      const builtFraction = active ? Math.min(0.92, Math.max(0.08, row.tokens.total / p95)) : 1;
      const ageHours = Math.max(0.75, (generatedAt - startedAt) / 3_600_000);
      const tokensPerHour = row.tokens.total / ageHours;
      buildings.push({
        id: row.session_ref,
        assetRef: row.asset_ref ?? undefined,
        districtId: harnessId,
        archetype: archetypeFor(seed, height, landmark && height > 24),
        facade: Math.floor(seed * 997) % 3,
        seed,
        tokensTotal: row.tokens.total,
        height: finalHeight,
        footprint: 3.4 + seed * 1.6 + Math.min(2.2, height * 0.035),
        startedAt,
        endedAt: active ? null : endedAt,
        active,
        builtFraction,
        busyness: active ? Math.min(1, Math.max(0.18, Math.log10(1 + tokensPerHour) / 5)) : 0,
        aggregated: false,
        extraCount: 0,
      });
      rowsIndex.set(row.session_ref, row);
    }

    if (overflow.length) {
      aggregatedSessions += overflow.length;
      const overflowTokens = overflow.reduce((sum, row) => sum + row.tokens.total, 0);
      const fillerCount = Math.min(26, Math.max(2, Math.round(overflow.length / 24)));
      for (let index = 0; index < fillerCount; index += 1) {
        const seed = hashSeed(`${harnessId}:fill:${index}`);
        const share = overflow.length / fillerCount;
        const tokens = Math.round(overflowTokens / fillerCount);
        const height = Math.max(3, Math.min(26, tokensToHeight(tokens) * 0.42));
        buildings.push({
          id: `fill:${harnessId}:${index}`,
          districtId: harnessId,
          archetype: seed < 0.5 ? "midrise" : "block",
          facade: 1,
          seed,
          tokensTotal: tokens,
          height,
          footprint: 4.2 + seed * 1.4,
          startedAt: parseMs(overflow[Math.floor(seed * overflow.length) % overflow.length].first_event_at, input.windowStartMs),
          endedAt: generatedAt - 30 * 60_000,
          active: false,
          builtFraction: 1,
          busyness: 0,
          aggregated: true,
          extraCount: Math.round(share),
        });
      }
    }

    const tokensTotal = harnessRows.reduce((sum, row) => sum + row.tokens.total, 0);
    districts.push({
      id: harnessId,
      label: input.harnessNames?.[harnessId] ?? harnessId,
      // 本区载入的会话数（含聚合）。曾在截断时写成全城 totalSessions——每个区都显示同一个全城总数。
      sessionCount: harnessRows.length,
      tokensTotal,
      // 聚合进背景楼群的会话也计入（菜单栏不区分是否单独成楼）。
      activeCount: districtActive + overflow.filter((row) => isActiveToday(parseMs(row.last_event_at, 0), generatedAt)).length,
      anomaly: anomalyFromFindings(findingsByHarness.get(harnessId) ?? []),
    });
  }

  const tokensTotal = input.rows.reduce((sum, row) => sum + row.tokens.total, 0);
  return {
    generatedAt,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
    windowLabel: input.windowLabel,
    districts,
    buildings,
    stats: {
      renderedSessions: input.rows.length - aggregatedSessions,
      aggregatedSessions,
      totalSessions: Math.max(input.totalSessions, input.rows.length),
      tokensTotal,
      activeCount: districts.reduce((sum, district) => sum + district.activeCount, 0),
      truncated: input.truncated,
    },
    rows: rowsIndex,
  };
}

/**
 * Replay 语义：在时间游标 cursor 下这栋楼"已建成多少"。token 在会话生命周期内
 * 线性累计是可视化近似（列表数据没有逐事件 token 序列），进度含义已在 HUD 标注。
 * 活跃会话以当前 token 数按已流逝时长折算，之后随真实数据增长。
 */
/** 回放进度：cursor 时刻这栋楼长到几分之几。
 *  pace>0（回放/拖动）时把「升起时长」夹在 0.9–3.5 墙钟秒（seed 决定 stagger）——
 *  若严格等于会话时长，短会话一帧闪现整楼、长会话整段回放都在爬，同屏快慢楼
 *  交错读起来像乱序；夹住后每栋楼都有一段可见的施工动画，且先后仍由 startedAt 决定。 */
export function builtFractionAt(building: CityBuilding, cursor: number, live: boolean, paceMsPerSec = 0): number {
  if (cursor < building.startedAt) return 0;
  if (building.active && live) return building.builtFraction;
  const span = (building.endedAt ?? building.startedAt) - building.startedAt;
  let effSpan = span;
  if (paceMsPerSec > 0) {
    const floor = (0.9 + building.seed * 0.6) * paceMsPerSec;
    effSpan = Math.min(Math.max(span, floor), 3.5 * paceMsPerSec);
  }
  if (!Number.isFinite(effSpan) || effSpan <= 0) return 1;
  if (building.aggregated && paceMsPerSec <= 0) return cursor >= building.startedAt ? 1 : 0;
  const fraction = (cursor - building.startedAt) / effSpan;
  return Math.min(1, Math.max(0.04, fraction));
}
