import { formatTokenCount, message, useLanguage, type AppLanguage } from "../lib/i18n";
import { bucketTotal, niceMax, type TrendBucket } from "../features/usage/trendBuckets";

/**
 * OVERVIEW_TREND_RANGE_SPEC §2.3：总览（本日/本周/本月）与用量页（小时明细）共用的
 * 趋势柱图。纯展示——不拉数据、不算日期，桶由 features/usage/trendBuckets.ts 装配。
 *
 * 诚实性：三种「没有柱」必须分得清——future（还没发生，留空位）、unavailable
 * （读不到，灰斜纹）、0（读到了、没有已观测事实，2px 基线）。失败标记同理：
 * failures === null 是「标记不可用」，0 才是「读到零失败」，两者不得混同。
 *
 * 视觉（§0 评审）：柱宽随容器伸缩、无写死的 22px 上限（仅周档 7 根粗柱设 --trend-bar-max
 * 以免撑成巨块）；Y 轴三刻度；悬停/聚焦浮层给分执行环境明细。
 */
export type UsageTrendChartProps = {
  buckets: TrendBucket[];
  ariaLabel: string;
  /** false = 不显示任何失败标记/图例（用量页）。 */
  showFailures?: boolean;
  /** 单根柱最大宽度（px）；不传 = 不限（随容器伸缩）。 */
  barMax?: number;
  /** 传了就把柱渲染成按钮（用量页选日期等）；桶有 href 时优先渲染链接。 */
  onSelect?: (bucket: TrendBucket) => void;
};

function weekdayText(weekday: number | undefined, language: AppLanguage): string {
  if (weekday == null) return "";
  // 2024-01-07 是周日（UTC）：用 UTC 日期 + timeZone:"UTC" 格式化，不经本地时区。
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(2024, 0, 7 + weekday)));
}

function summaryOf(bucket: TrendBucket, language: AppLanguage): string {
  if (bucket.state === "future") return message("trend.future", language);
  if (bucket.state === "unavailable") return message("trend.unavailable", language);
  const total = bucketTotal(bucket);
  return total > 0 ? message("trend.tokens", language, { tokens: formatTokenCount(total) }) : message("trend.noUsage", language);
}

export function UsageTrendChart({ buckets, ariaLabel, showFailures = true, barMax, onSelect }: UsageTrendChartProps) {
  const language = useLanguage();
  const okBuckets = buckets.filter((bucket) => bucket.state === "ok");
  const peak = Math.max(0, ...okBuckets.map(bucketTotal));
  const axisMax = niceMax(peak);
  const failureTotal = okBuckets.reduce((sum, bucket) => sum + (bucket.failures ?? 0), 0);
  const failureUnavailable = okBuckets.some((bucket) => bucket.failures == null);
  const lastIndex = buckets.length - 1;
  return <div className="trend-chart" role="group" aria-label={ariaLabel} style={barMax ? ({ ["--trend-bar-max" as string]: `${barMax}px` }) : undefined}>
    <div className="trend-legend">
      <span><i className="trend-seg-dsh" aria-hidden="true" />DSH</span>
      <span><i className="trend-seg-claude" aria-hidden="true" />Claude Code</span>
      <span><i className="trend-seg-codex" aria-hidden="true" />Codex</span>
      {showFailures && failureTotal > 0 && <span><i className="trend-flag" aria-hidden="true" />{message("trend.failureLegend", language, { count: failureTotal })}</span>}
      {showFailures && failureUnavailable && <span className="trend-legend-warn">{message("trend.failureUnavailable", language)}</span>}
      {showFailures && !failureUnavailable && failureTotal === 0 && okBuckets.length > 0 && <span className="trend-legend-muted">{message("trend.noFailures", language)}</span>}
    </div>
    <div className="trend-plot">
      <div className="trend-yaxis" aria-hidden="true">
        <span>{formatTokenCount(axisMax)}</span>
        <span>{formatTokenCount(axisMax / 2)}</span>
        <span>0</span>
      </div>
      <div className="trend-area">
        <div className="trend-grid" aria-hidden="true"><i /><i /><i /></div>
        <div className="trend-cols">
          {buckets.map((bucket, index) => {
            const total = bucketTotal(bucket);
            const failed = showFailures && (bucket.failures ?? 0) > 0;
            const failuresText = failed ? `, ${message("trend.failuresInBucket", language, { count: bucket.failures ?? 0 })}` : "";
            const title = bucket.weekday != null ? `${bucket.title} ${weekdayText(bucket.weekday, language)}` : bucket.title;
            const summary = summaryOf(bucket, language);
            const interactive = Boolean(bucket.href) || Boolean(onSelect);
            const aria = message(interactive ? "trend.bucketAriaOpen" : "trend.bucketAria", language, { title, summary, failures: failuresText });
            const height = bucket.state !== "ok" ? 0 : total > 0 ? Math.max(3, (total / axisMax) * 100) : 0;
            const tipSide = index <= lastIndex * 0.15 ? "trend-tip-left" : index >= lastIndex * 0.85 ? "trend-tip-right" : "";
            const inner = <>
              <span className="trend-bar-slot">
                {bucket.state === "unavailable" && <span className="trend-bar trend-bar-unavailable" style={{ height: "100%" }} />}
                {bucket.state === "ok" && (total > 0
                  ? <span className={`trend-bar ${failed ? "trend-bar-failed" : ""}`} style={{ height: `${height}%` }}>
                    {bucket.codex ? <i className="trend-seg-codex" style={{ flexGrow: bucket.codex }} /> : null}
                    {bucket.claude ? <i className="trend-seg-claude" style={{ flexGrow: bucket.claude }} /> : null}
                    {bucket.dsh ? <i className="trend-seg-dsh" style={{ flexGrow: bucket.dsh }} /> : null}
                  </span>
                  : <span className="trend-bar-empty" />)}
              </span>
              <span className="trend-flag-slot" aria-hidden="true">{failed ? <i className="trend-flag" /> : null}</span>
              <small aria-hidden="true" className={bucket.state === "future" ? "trend-label-future" : undefined}>{bucket.label}</small>
              {bucket.state !== "future" && <span className={`trend-tip ${tipSide}`} role="tooltip" aria-hidden="true">
                <strong>{title}</strong>
                <span>{summary}</span>
                {bucket.state === "ok" && total > 0 && <>
                  {bucket.dsh != null && <span><i className="trend-seg-dsh" />DSH {formatTokenCount(bucket.dsh)}</span>}
                  {bucket.claude != null && <span><i className="trend-seg-claude" />Claude Code {formatTokenCount(bucket.claude)}</span>}
                  {bucket.codex != null && <span><i className="trend-seg-codex" />Codex {formatTokenCount(bucket.codex)}</span>}
                </>}
                {failed && <span className="trend-tip-failure"><i className="trend-flag" />{message("trend.failuresInBucket", language, { count: bucket.failures ?? 0 })}</span>}
              </span>}
            </>;
            const className = `trend-col trend-col-${bucket.state} ${interactive ? "trend-col-interactive" : ""}`;
            if (bucket.href) return <a key={bucket.key} className={className} href={bucket.href} aria-label={aria}>{inner}</a>;
            if (onSelect) return <button key={bucket.key} type="button" className={className} aria-label={aria} onClick={() => onSelect(bucket)}>{inner}</button>;
            return <div key={bucket.key} className={className} role="img" aria-label={aria} tabIndex={bucket.state === "future" ? -1 : 0}>{inner}</div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}
