#!/usr/bin/env node
// Keep Agent harness identifiers distinct from the Agent Vitals plugin host.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(repo, name), "utf8");
assert.ok(existsSync(path.join(repo, "crates/agent-vitals-harnesses/src/harnesses")));
assert.ok(!existsSync(path.join(repo, "crates/agent-vitals-hosts")));
assert.ok(existsSync(path.join(repo, "docs/schemas/harness-manifest-v1.json")));
assert.ok(!existsSync(path.join(repo, "docs/schemas/host-manifest-v1.json")));
assert.match(read("Cargo.toml"), /crates\/agent-vitals-harnesses/);
assert.match(read("apps/desktop/src-tauri/src/lib.rs"), /plugin_host::PluginHost/);
assert.match(read("apps/agent-city/ui/src/CityApp.tsx"), /from "\.\/host"/);
assert.match(read("apps/agent-city/ui/src/data/provider.ts"), /CityProjectionV1 = CityUiProjectionV2/);
assert.match(read("packages/agent-vitals-app-sdk/src/city-ui-projection.ts"), /harness: string/);
assert.doesNotMatch(read("packages/agent-vitals-app-sdk/src/city-ui-projection.ts"), /\bhost: string/);
assert.doesNotMatch(read("apps/agent-city/ui/src/data/provider.ts"), /\bhost: string/);
const authoritySource = read("crates/agent-vitals-data/src/authority.rs");
const authoritySchema = authoritySource.match(/pub const SCHEMA_VERSION: i64 = (\d+);/)?.[1];
assert.ok(authoritySchema, "authority schema version must be declared");
assert.ok(Number(authoritySchema) >= 31, "harness terminology rename requires schema v31 or newer");
// Network hostname evidence is not an Agent execution environment identifier.
assert.match(read("crates/agent-vitals-provider/src/lib.rs"), /pub endpoint_host: Option<String>/);
assert.match(read("apps/agent-city/ui/package.json"), /vite --host 127\.0\.0\.1/);

const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { transformSync } = require("esbuild");
const module = { exports: {} };
const source = transformSync(read("apps/desktop/ui-dev/react/src/lib/harnessNames.ts"), { loader: "ts", format: "cjs" }).code;
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({}) });
const { harnessName } = module.exports;
assert.equal(harnessName("codex"), "Codex");
assert.equal(harnessName("claude-code"), "Claude Code");
assert.equal(harnessName("harness:sample_agent"), "Sample Agent");
assert.equal(harnessName(null), "—");
assert.equal(harnessName("host:sample_agent"), "host:sample_agent", "Old prefix must not be treated as a harness alias");
console.log("Harness terminology: renamed crate/schema/DTOs, preserved plugin host and DNS host, display names passed.");
