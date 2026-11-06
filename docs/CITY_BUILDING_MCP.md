# Agent City building MCP (MVP)

External agents can read, preview, apply, and reset **one session building's 3D model** through Data MCP. Persistence is a City-owned SQLite override keyed by stable `asset_ref`. After a successful set/reset the write path **persists → pushes a shared host event → City plays construction**.

## Tools

Server: `agent-vitals data-mcp serve --allow-local-writes` (get/preview work without the flag; set/reset need it).

`session_id` is either:

- `sessions_search.session_ref` (`sr_` + 32 hex), or
- the building `asset_ref` (`ca_` + 32 hex) returned by `get_building`.

| Tool | Writes? | Contract |
|---|---|---|
| `get_building` | no | Resolved mesh (override or default), optional stored `inheritance` subclass, `revision`, `kit_version`, parts, geometric `summary`, `observe.text` |
| `preview_building` | no | Validate an **inheritance rewrite** only (no full mesh). Same structured errors as set. |
| `set_building_model` | yes | Persist a subclass document. Optimistic concurrency on `expected_revision`. Success → new `revision` + `build_event_id` |
| `reset_building` | yes | Clear override, restore default, bump `revision`, queue a build event |

ReACT loop: **get → preview → (show `data.warnings`) → set → get**. Confirm the set by matching `revision` and `build_event_id`. `data.ok` is not design approval. Observation is structured JSON (`data.observe`); screenshots are optional and **not** in this MVP.

**Agent tool surface:** `preview_building` and `set_building_model` accept **`inheritance` rewrites only** — not a full `{kit_version, params, parts}` mesh replace. Full mesh replace remains available to internal/debug callers only. Passing `model` on MCP returns `invalid_argument`.

## Model (`session-kit/v1` resolved mesh)

`get_building.model` is always the **resolved** mesh after base + overrides merge:

```json
{
  "kit_version": "session-kit/v1",
  "params": { "form": "tower" },
  "parts": [
    { "id": "base", "kind": "box", "role": "structure", "at": [0, 0, 0], "size": [3, 2, 3] },
    { "id": "cap", "kind": "cone", "role": "roof", "at": [0, 2, 0], "size": [2, 1.5, 2] }
  ]
}
```

- `parts` length 1–64.
- `kind`: `box` | `cylinder` | `cone`. `role`: `wall` | `trim` | `roof` | `glass` | `structure` | `door` | `window`.
- `at` is the base centre (y = bottom). `size` is `[x, y, z]` extents. Optional `rot`, `color` (`#rrggbb`).
- `params.form`: `tower` | `slab` | `block` | `midrise`. Optional `params.palette`, `params.catalog_id`, `params.build_cost`, `params.floors`, `params.story_height`, `params.detail_tier` (`coarse` | `standard` | `detailed` or `0`..`2`).
- No scripts, no extra fields. Unknown `kit_version` is a validation error. Stored overrides keep their `kit_version` so old rows are not silently migrated.

## Inheritance (layer 2 — agent writes)

Stored subclass (`kit_version: session-kit/inheritance/v1`). Also returned on `get_building` when present.

```json
{
  "kit_version": "session-kit/inheritance/v1",
  "base": { "kind": "catalog", "catalog_id": "kit-fine-midrise" },
  "overrides": {
    "params": { "palette": "#c47a54", "story_height": 3.2, "detail_tier": "detailed" },
    "parts_replace": [{ "id": "door", "part": { "id": "door", "kind": "box", "role": "door", "at": [0, 0, 3.11], "size": [1.3, 2.2, 0.2] } }],
    "parts_add": [{ "id": "sign", "kind": "box", "role": "trim", "at": [0, 8.1, 3], "size": [1.2, 0.4, 0.2] }],
    "parts_remove": ["cornice"]
  }
}
```

**Base (re-base):**

| `base.kind` | Meaning |
|---|---|
| `projection` | Session token-derived default kit (same as no override) |
| `catalog` | Built-in catalog mesh; requires `base.catalog_id` from `get_building.projection.compliant_catalog` |

**Override kinds:** `overrides.params` (scalar merge), `parts_replace` (`{id, part}`), `parts_add`, `parts_remove` (id list).

**Reset subclass:** `{ "kit_version": "session-kit/inheritance/v1", "reset": true }` on preview/set clears the stored override (same effect as `reset_building` on set). `reset_building` remains the explicit tool.

**Server path (preview + set):** resolve `base` → merge `overrides` → `validate_model` → **model compliance (#9)** → **detail regression (#10)** → **design coherence** on the merged mesh. Persist the **inheritance document**, not the resolved mesh.

**Fine catalog samples** (for re-base and `parts_add` tests): `kit-fine-midrise`, `kit-fine-storefront` — detailed tiers, door/window roles, richer part layouts. Legacy ids: `kit-low-block`, `kit-midrise`, `kit-tower`, `kit-wide-slab`.

Legacy SQLite rows may still store a full `session-kit/v1` mesh from before layer 2; `get_building` and City `buildings.overrides` resolve them as-is.

**Geometry checks:** finite numbers, parts ≤64, lot envelope (±4 x, ±6 z, height 0–48 world units), AABB overlap.

**Model compliance (preview + set, same path):** derived lot footprint (min coverage + max bounds), session height class + story height (`params.story_height` / `params.floors`, reject pillar-like single shafts), construction budget (`estimate` or `params.build_cost` vs session `budget_cap`; catalog `cost` when `catalog_id` set), and required `door` / `window` part roles for occupiable models (waived when `catalog_id` points at a kit that provides them). Failures use `rule: invalid_model` and may include `compliant_models` (catalog ids). `get_building.projection` returns `lot`, `compliant_catalog`, and `required_part_roles`.

**Detail regression (layer 1, after compliance):** compare a cheap **detail score** for the session’s **current** model (override or default) vs the **merged** proposal. Inputs: part count, door/window presence (or catalog kit that provides them), and `params.detail_tier` (`coarse` | `standard` | `detailed` or `0`..`2`; otherwise derived from part count or catalog). **Hold-or-improve:** proposed score must be ≥ current. Failures use `rule: detail_regression` and may list `compliant_models` catalog ids that would not regress.

**Design coherence (after #9/#10):** keep the current building’s mass and attach new parts to it. This is not an aesthetic model.

| Result | `rule` | When |
|---|---|---|
| Reject (`ok: false`, City fail-flash) | `disconnected_part` | A structure part is not in the main connected mass, or a door/window/trim/glass does not touch that mass. |
| Reject (`ok: false`, City fail-flash) | `massing_drift` | Height stays about the same (±12%) but footprint grows >22%, or a structural `parts_add` rebuilds the mass (≥4 structural adds or >35% extra volume). |
| Warning (`ok: true`, `data.warnings[]`) | `massing_shift` | Height or footprint changes enough to notice, including an intentional catalog re-base. |
| Warning (`ok: true`, `data.warnings[]`) | `additive_override` | Three or more added parts, or added volume >18% of the current mesh. |

`data.ok` is **not** design approval. Agents must show every `data.warnings` entry before `set_building_model`. Reset (`reset: true` / `reset_building`) skips this layer. A catalog re-base with only params / facade adds is allowed (with `massing_shift`) so kit swaps stay possible; hanging new bases or decks on the current shaft is not.

## Errors

Preview and set share one shape inside `data` (check `data.ok`; this is not a JSON-RPC error):

```json
{
  "ok": false,
  "error": {
    "kind": "validation",
    "rule": "overlap",
    "parts": ["a", "b"],
    "message": "parts `a` and `b` overlap",
    "suggested_fix": "move or shrink one of the two parts so their boxes no longer intersect"
  }
}
```

Inheritance shape errors use `rule: invalid_inheritance`. `kind` is `validation` or `conflict` (`revision_conflict` — retry with `get_building.revision`). Unknown `session_id` is MCP `not_found`. Mutations without `--allow-local-writes` are `permission_denied`.

## Persistence

`~/.agent-vitals/state/plugins/city-buildings/overrides.sqlite` (or `$AGENT_VITALS_HOME/...`):

- `overrides(asset_ref, revision, kit_version, model_json, updated_at_ms)` — `model_json` NULL means default. Layer 2 stores the inheritance JSON; legacy rows store a full mesh.
- `build_events(build_event_id, asset_ref, revision, kind, part_count, created_at_ms)` — queued, replayable construction records.

Atomic `BEGIN IMMEDIATE` check-and-commit. Survives app restart. Parcel/lot metadata is reported `unavailable` until the city loader can supply it.

## UI bridge (persist → push → animate)

MCP is a separate stdio process, so it cannot emit a Tauri event directly. After COMMIT the query layer:

1. Writes `state/plugins/city-buildings/notify.json` (durable mailbox).
2. Best-effort JSON line to `state/plugins/city-buildings/host.sock` when PluginHost is listening.
3. PluginHost evals **one shared CustomEvent** on the City webview: `__AV_PLUGIN_ENTITY_CHANGED__`.
4. City dispatches on `entity_kind`. `"building"` applies the session-kit overlay and plays block-by-block construction. Other kinds are ignored until a handler exists.

Host → City envelope (reusable; this PR implements `building`):

```json
{
  "type": "CityEntityChanged",
  "schema_version": 1,
  "entity_kind": "building",
  "entity_id": "ca_…",
  "action": "set",
  "revision": 1,
  "event_id": "be_…"
}
```

`action` is `set` | `reset` | `preview` | `reject`. Persist set/reset also carry MCP/SQLite aliases (`asset_ref`, `build_event_id`, `kind`) plus the resolved kit `model`. Tool JSON still returns `build_event_id`. `construction.ui` is `pushed` (socket accepted) or `queued` (mailbox + poll).

### Visible edit states (ghost + fail-flash)

These are **UI-only** and never persist to `overrides` / `build_events`:

| Trigger | Envelope `action` | City render |
|---|---|---|
| Successful `preview_building` (including `{reset:true}`) | `preview` | Translucent **ghost** of the proposed mesh on the session lot. The committed building stays. |
| `preview_building` or `set_building_model` rejected by **model compliance** (`invalid_model`, #9), **detail regression** (`detail_regression`, #10), or **design coherence** (`disconnected_part`, `massing_drift`) | `reject` | Brief red **fail-flash** on the lot (~900 ms). |

Other structured errors (`overlap`, `invalid_inheritance`, `revision_conflict`) stay MCP-only — no City flash.

Delivery: same PluginHost channel (`__AV_PLUGIN_ENTITY_CHANGED__`). Preview/reject write `state/plugins/city-buildings/edit.json` and best-effort `host.sock`. They **do not** overwrite persist `notify.json`, so a mailbox poll cannot drop a queued construction event. Tool JSON grows an output-only `notify` object (`action`, `event_id`, `ui`); input schemas are unchanged.

The same write path **also** fans out a squad IM envelope (`kind: preview|reject|set|reset`) onto `squad.json` + the same `host.sock`. Agents must not also call `im_publish` to report those writes. See `docs/CITY_SQUAD_IM.md`.

A later successful `set` / `reset` clears the ghost and plays construction (PR #8). Cold open snaps committed overrides only — ghosts are live/ephemeral. Decal/graffiti and agent labels are not in this PR.

Load path: city:v3 `buildings.overrides` (not stuffed into session pages — kit floats must not go through the integer-only v3 validator). Cold open **snaps** current overrides (resolved `model` + optional `inheritance`). Live host/poll events **animate**. City also polls `build_events` every 8s if the eval landed before the listener.

PluginHost delivers each `event_id` at most once while the City webview is ready.

## Try it

```bash
python3 scripts/verify-city-building-mcp.py
# optional live tools/list check:
python3 scripts/verify-city-building-mcp.py --bin target/debug/agent-vitals
```

Against a real install (after `sync-facts` so sessions exist), with City open:

```bash
agent-vitals data-mcp serve --allow-local-writes
```

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sessions_search","arguments":{"limit":1}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_building","arguments":{"session_id":"sr_…"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"preview_building","arguments":{"session_id":"sr_…","inheritance":{"kit_version":"session-kit/inheritance/v1","base":{"kind":"catalog","catalog_id":"kit-fine-midrise"},"overrides":{"params":{"palette":"#c47a54"}}}}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_building_model","arguments":{"session_id":"sr_…","expected_revision":0,"inheritance":{"kit_version":"session-kit/inheritance/v1","base":{"kind":"catalog","catalog_id":"kit-fine-midrise"},"overrides":{}}}}}
```

Copy `session_ref` from `sessions_search` into `session_id`. With City open, set should push `__AV_PLUGIN_ENTITY_CHANGED__` and play construction; `get_building` must show the new `revision`, resolved parts, and stored `inheritance`. Restart still shows the override. `reset_building` restores the default with animation.

## Deferred (not in this PR)

- Pin/snapshot revision (layer 3).
- OT/CRDT. Aesthetic *taste* is still out of scope; massing/attachment is the geometric stand-in shipped above.
- Road / vehicle write-path animation (the envelope and channel are ready; no handlers yet).
- Parcel/lot coordinates, screenshots, resident metrics, hard locks / OT (phase 1 has a stealable TTL claim on `(session_id, asset_ref)` plus IM fanout; see `docs/CITY_SQUAD_IM.md`).
- `get_squad_feed`, verbose `observe`, agent labels, decal/graffiti.
