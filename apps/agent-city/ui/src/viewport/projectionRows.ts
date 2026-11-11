import type { CitySessionRow } from "../cityModel";
import type { CityProjectionV1 } from "../data/provider";

/** Studio 视口固定看全年窗口；City 设置里的其他档位只影响 City 页面。 */
export type CityViewportWindowDays = 7 | 30 | 90 | 366;

/**
 * 投影 → 城市会话行的唯一映射。CityApp 与 Studio 视口都必须走这里，
 * 两边才会在同一份数据上生成同一座城市（行序、token 归并、费用降级完全一致）。
 */
export function projectionSessionRows(projection: CityProjectionV1): CitySessionRow[] {
  return projection.sessions.map((session) => ({
    session_ref: session.id,
    asset_ref: session.asset_ref ?? null,
    harness: session.harness,
    title: session.title ?? null,
    title_source: session.title_source ?? null,
    first_event_at: session.first_event_at,
    last_event_at: session.last_event_at,
    event_count: session.event_count ?? 1,
    peak_tokens: session.tokens.total,
    model_ids: session.model_ids ?? [],
    tokens: {
      uncached_input_tokens: session.tokens.uncached_input ?? session.tokens.input,
      cache_read_tokens: session.tokens.cache_read ?? 0,
      cache_write_tokens: session.tokens.cache_write ?? 0,
      output_tokens: session.tokens.output,
      total: session.tokens.total,
    },
    cost_minor: session.cost_minor && ["metered_actual", "metered_estimate", "fixed_subscription", "api_equivalent", "other"].includes(session.cost_minor.basis)
      ? session.cost_minor as CitySessionRow["cost_minor"] : null,
    cost_status: session.cost_status ?? { state: "unavailable", reason: "cost_not_projected", has_unresolved: true },
  }));
}
