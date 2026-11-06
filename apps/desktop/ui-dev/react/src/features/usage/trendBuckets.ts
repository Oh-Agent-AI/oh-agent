// OVERVIEW_TREND_RANGE_SPEC §2：趋势图的桶装配——纯函数、无 I/O、无 React。
// 总览（本日/本周/本月）与用量页（小时明细）都先在这里把各自的数据整形成同一种
// TrendBucket，再交给共享的 UsageTrendChart 渲染；两处不再各写一套柱高/空值逻辑。
//
// 日期运算只对 "YYYY-MM-DD" 做公历运算（Date.UTC + getUTC*），**不经本地时区**——
// 本地 Date 在 DST 换日、负时区下会把日期推前/后一天，周起点就会错一天。
import type { UsageCalendar, UsageDay, UsageHourly } from "../../lib/tauri";

export type TrendRange = "day" | "week" | "month";

export type TrendBucket = {
  key: string;
  /** 轴标签；空串 = 不显示（稀疏标注）。 */
  label: string;
  /** 完整标题（悬停浮层用，语言中性），如 "09:00" / "2026-10-01"。 */
  title: string;
  /** 日桶的星期（0=周日），由组件按界面语言格式化；小时桶无。 */
  weekday?: number;
  /** null = 该执行环境读不到（不是 0）。 */
  dsh: number | null;
  claude: number | null;
  codex: number | null;
  /** null = 失败标记不可用（不是 0）；0 = 读到零失败。 */
  failures: number | null;
  /** future = 还没发生，不画柱；unavailable = 数据读不到，不是 0。 */
  state: "ok" | "future" | "unavailable";
  href?: string;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`非法日期：${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return fmt(Date.UTC(y, m - 1, d) + days * 86_400_000);
}

/** 0=周日 … 6=周六（公历，与时区无关）。 */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 自然周起点：周一（SPEC §6 默认决策）。 */
export function weekStartOf(date: string): string {
  const offset = (weekdayOf(date) + 6) % 7; // 周一 0 … 周日 6
  return addDays(date, -offset);
}

export function weekDates(today: string): string[] {
  const start = weekStartOf(today);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthDates(month: string): string[] {
  return Array.from({ length: daysInMonth(month) }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function bucketTotal(bucket: TrendBucket): number {
  return bucket.state === "ok" ? (bucket.dsh ?? 0) + (bucket.claude ?? 0) + (bucket.codex ?? 0) : 0;
}

/** Y 轴上沿取「漂亮数」：1/2/5 × 10^n 上取整，保证峰值柱不顶格、刻度线可读。 */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** 24 个小时桶。failureHours 为 null → 失败标记不可用；hourly 为 null → 全桶 unavailable。 */
export function buildHourBuckets(
  hourly: UsageHourly | null,
  failureHours: Record<string, number> | null | undefined,
  hrefFor?: (hour: number) => string,
): TrendBucket[] {
  const byHour = new Map((hourly?.hours ?? []).map((row) => [row.hour, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    const text = String(hour).padStart(2, "0");
    return {
      key: text,
      label: hour % 6 === 0 || hour === 23 ? text : "",
      title: `${text}:00`,
      dsh: row ? row.dsh_tokens : null,
      claude: row ? row.claude_tokens : null,
      codex: row ? row.codex_tokens : null,
      failures: failureHours == null ? null : (failureHours[String(hour)] ?? 0),
      state: hourly == null ? "unavailable" : "ok",
      href: hrefFor?.(hour),
    } satisfies TrendBucket;
  });
}

/**
 * 日桶（周 7 / 月 28–31）。
 * - 晚于 today → future（不画柱、不进峰值）；
 * - 所属月的日历读不到（null / 未提供）→ unavailable，而不是 0；
 * - 日历读到了但没这一天 = 没有已观测事实 → 0 柱（与用量页「空格不补造」一致）。
 */
export function buildDayBuckets(
  dates: string[],
  today: string,
  calendars: Record<string, UsageCalendar | null | undefined>,
  failureDays: Record<string, number> | null | undefined,
  hrefFor?: (date: string) => string,
  labelEvery = 1,
): TrendBucket[] {
  const dayMaps = new Map<string, Map<string, UsageDay> | null>();
  for (const [month, calendar] of Object.entries(calendars)) {
    dayMaps.set(month, calendar ? new Map(calendar.days.map((day) => [day.date, day])) : null);
  }
  return dates.map((date, index): TrendBucket => {
    const map = dayMaps.get(monthOf(date));
    const base = {
      key: date,
      label: index % labelEvery === 0 ? String(Number(date.slice(8))) : "",
      title: date,
      weekday: weekdayOf(date),
      href: hrefFor?.(date),
    };
    if (date > today) return { ...base, dsh: null, claude: null, codex: null, failures: null, state: "future" };
    if (!map) return { ...base, dsh: null, claude: null, codex: null, failures: null, state: "unavailable" };
    const day = map.get(date);
    return {
      ...base,
      dsh: day?.dsh_tokens ?? 0,
      claude: day?.claude_tokens ?? 0,
      codex: day?.codex_tokens ?? 0,
      failures: failureDays == null ? null : (failureDays[date] ?? 0),
      state: "ok",
    };
  });
}

/** 本周跨月时需要补读的月份（周一所在月 ≠ 今天所在月）；不跨月 → null。 */
export function weekExtraMonth(today: string): string | null {
  const startMonth = monthOf(weekStartOf(today));
  return startMonth === monthOf(today) ? null : startMonth;
}
