/* Generated from docs/schemas by generate-app-contracts.mjs. Do not edit. */

export type CityProjectionRequestV1 =
  | {
      projection: "city";
      version: 1;
      face: "app-local";
      operation: "open";
      window_kind: "7d" | "30d" | "90d" | "366d";
      page_size: number;
    }
  | {
      projection: "city";
      version: 1;
      face: "app-local";
      operation: "next";
      snapshot_id: string;
      cursor: string;
    }
  | {
      projection: "city";
      version: 1;
      face: "app-local";
      operation: "recent";
      snapshot_id: string;
    };

export interface CityDataProjectionV1 {
  projection: "city";
  version: 1;
  face: "app-local";
  operation: "open" | "next" | "recent";
  window: {
    date_from: string;
    date_to: string;
    timezone: string;
    start_ms: number;
    end_ms_exclusive: number;
    as_of_ms: number;
  };
  snapshot: {
    id: string;
    data_revision: number;
    expires_at_ms: number;
  };
  /**
   * @maxItems 500
   */
  sessions: Session[];
  /**
   * @maxItems 128
   */
  harness_summaries: HarnessSummary[];
  coverage: {
    window_session_count: number | null;
    window_tokens_total: number | null;
    returned_count: number;
    unknown_time_session_count: number | null;
    sessions_state: "complete" | "partial" | "unknown";
    anomalies_state: "complete" | "partial" | "unavailable";
  };
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
  };
  freshness: {
    state: "available" | "updating" | "stale" | "unsynced";
    reason_code: "none" | "sync_in_progress" | "snapshot_stale" | "not_synced" | "partial_sources";
  };
}
export interface Session {
  opaque_id: string;
  /**
   * Only registered public harness IDs or literal unknown; C4 checks registry membership.
   */
  harness: string;
  first_event_ms: number | null;
  last_event_ms: number | null;
  event_count: number;
  /**
   * @maxItems 64
   *
   * Items: Only IDs present in the harness's approved public model catalog, or literal unknown. C4 must enforce catalog membership; syntax alone does not prove redaction.
   */
  model_ids: string[];
  tokens: {
    uncached_input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    total: number;
  };
  peak_tokens: number | null;
  cost_minor: {
    amount_minor: number;
    currency: string;
    basis: "metered_actual" | "metered_estimate" | "fixed_subscription" | "api_equivalent" | "other";
  } | null;
  cost_status: {
    state: "estimated" | "actual" | "subscription" | "unpriced" | "unavailable";
    reason_code:
      "none" | "missing_price" | "missing_billing_evidence" | "mixed_billing" | "source_unavailable" | "unknown";
    has_unresolved: boolean;
  };
  reliability: {
    time: "known" | "partial" | "unknown";
    usage: "complete" | "partial" | "unknown";
    models: "known" | "partial" | "unknown";
  };
}
export interface HarnessSummary {
  /**
   * Only registered public harness IDs or literal unknown; C4 checks registry membership.
   */
  harness: string;
  session_count: number | null;
  tokens_total: number | null;
  active_count: number | null;
  anomaly_count: number | null;
  highest_severity: "none" | "info" | "warning" | "critical";
  /**
   * @maxItems 64
   */
  anomaly_categories: ("billing" | "execution" | "behavior" | "source_quality" | "unknown")[];
}

export interface AppProjectionErrorV1 {
  protocol_version: 1;
  request_id: string;
  code:
    | "invalid_request"
    | "unsupported_projection"
    | "unsupported_version"
    | "unsupported_face"
    | "permission_denied"
    | "grant_revoked"
    | "unauthenticated"
    | "busy"
    | "timeout"
    | "cancelled"
    | "snapshot_expired"
    | "invalid_cursor"
    | "harness_offline"
    | "data_unavailable"
    | "internal_error";
  retryable: boolean;
  retry_after_ms: number | null;
}

export const PROJECTION_CAPABILITIES = [
  {
    "id": "city",
    "version": 1,
    "face": "app-local",
    "max_page_size": 500
  }
] as const;
