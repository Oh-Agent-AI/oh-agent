import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sdk = path.join(repo, "packages/agent-vitals-app-sdk");
export const requireSdk = createRequire(path.join(sdk, "package.json"));
export const metadata = JSON.parse(fs.readFileSync(path.join(repo, "docs/schemas/app-projection-metadata-v1.json"), "utf8"));
export const schemaNames = [...new Set(metadata.projections.flatMap((entry) => [entry.request_schema, entry.response_schema, entry.error_schema]))];
export const schemas = Object.fromEntries(schemaNames.map((name) => {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("invalid schema metadata path");
  return [name, JSON.parse(fs.readFileSync(path.join(repo, "docs/schemas", name), "utf8"))];
}));

const annotations = new Set(["title", "description", "$comment", "examples"]);
function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}
function validationForm(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const maps = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
  const lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const singles = new Set(["items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else"]);
  return Object.fromEntries(Object.keys(schema).sort().filter((key) => !annotations.has(key)).map((key) => {
    const value = schema[key];
    if (maps.has(key)) return [key, Object.fromEntries(Object.keys(value).sort().map((name) => [name, validationForm(value[name])]))];
    if (lists.has(key)) return [key, value.map(validationForm)];
    if (singles.has(key)) return [key, validationForm(value)];
    return [key, sortedValue(value)];
  }));
}

// Conservative initial-version gate. Any validation change needs an explicit
// version/review decision; this is not a general JSON Schema implication solver.
export function assertCompatible(baseline, candidate) {
  for (const [name, schema] of Object.entries(baseline)) {
    if (JSON.stringify(validationForm(schema)) !== JSON.stringify(validationForm(candidate[name]))) {
      throw new Error(`schema compatibility review required: ${name}`);
    }
  }
}

export function createValidators(input = schemas) {
  const Ajv2020 = requireSdk("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return Object.fromEntries(Object.entries(input).map(([name, schema]) => [name, ajv.compile(schema)]));
}

export function assertCityResponseInvariants(response) {
  if (response.coverage.returned_count !== response.sessions.length) throw new Error("page count mismatch");
  if (response.pagination.has_more !== (response.pagination.next_cursor !== null)) throw new Error("cursor state mismatch");
  if (response.window.start_ms >= response.window.end_ms_exclusive || response.snapshot.expires_at_ms <= response.window.as_of_ms) {
    throw new Error("invalid window or expiry");
  }
  const handles = new Set();
  for (const row of response.sessions) {
    if (handles.has(row.opaque_id)) throw new Error("duplicate session handle");
    handles.add(row.opaque_id);
    const sum = row.tokens.uncached_input_tokens + row.tokens.cache_read_tokens + row.tokens.cache_write_tokens + row.tokens.output_tokens;
    if (!Number.isSafeInteger(sum) || sum !== row.tokens.total) throw new Error("token total mismatch");
    if (row.first_event_ms !== null && row.last_event_ms !== null && row.first_event_ms > row.last_event_ms) throw new Error("invalid session time");
    const times = [row.first_event_ms, row.last_event_ms].filter((value) => value !== null).length;
    if ((row.reliability.time === "known" && times !== 2) || (row.reliability.time === "unknown" && times !== 0)
      || (row.reliability.time === "partial" && times !== 1)) throw new Error("time reliability mismatch");
    if (["unpriced", "unavailable"].includes(row.cost_status.state) && row.cost_minor !== null) throw new Error("unknown cost is not an amount");
    const { state, reason_code: reason, has_unresolved: unresolved } = row.cost_status;
    const allowed = { actual: ["metered_actual"], estimated: ["metered_estimate", "api_equivalent"], subscription: ["fixed_subscription"] };
    if (allowed[state] && (!row.cost_minor || !allowed[state].includes(row.cost_minor.basis))) throw new Error("cost basis/state mismatch");
    if ((reason !== "none") !== unresolved) throw new Error("cost reason/unresolved mismatch");
    if (["unpriced", "unavailable"].includes(state) && !unresolved) throw new Error("unknown cost requires uncertainty");
    if (["actual", "subscription"].includes(state) && unresolved) throw new Error("actual billing requires resolved evidence");
    if (row.harness.startsWith("harness:") && (row.cost_status.state === "subscription" || row.cost_minor?.basis === "fixed_subscription")) {
      throw new Error("data-plane subscription forbidden");
    }
  }
}
