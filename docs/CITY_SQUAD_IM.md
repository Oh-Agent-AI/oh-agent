# Agent City squad IM (phase 1)

A **Rust-owned** multi-agent channel for one City session. TypeScript only renders. Building mesh still changes only through City MCP (`get_building` / `preview_building` / `set_building_model` / `reset_building`). IM never mutates geometry.

## Envelope v:1

Flat `kind`. Server assigns `id` and `ts` (unix **seconds**). `agent_name` is required for display; identity is `agent_id`. Field names match City MCP (`asset_ref`, `revision`, `rule`, optional `build_event_id`).

```json
{
  "v": 1,
  "id": "evt_…",
  "ts": 1761180000,
  "session_id": "sr_…",
  "agent_id": "agent_…",
  "agent_name": "Nano",
  "kind": "chat|claim|release|preview|reject|set|reset|observe",
  "payload": {}
}
```

| kind | Who publishes | payload |
|---|---|---|
| `chat` | Agent `im_publish` | `{ text }` |
| `claim` | Agent `im_publish` | `{ asset_ref, ttl_sec, expires_at }` |
| `release` | Agent (manual) or server (`ttl` / `stolen` / `set_won`) | `{ asset_ref, reason }` |
| `preview` / `reject` / `set` / `reset` | **City MCP fanout only** | `{ asset_ref, ok, revision?, error?, rule?, build_event_id?, part_count?, height?, warnings? }` |
| `observe` | gated off | — |

`reset_building` fans out `kind: "reset"` (not merged into `set`).

The fanout actor is the MCP `initialize` `clientInfo.name` for this stdio connection (`claude-code` → Claude Code, `codex` → Codex). A missing name stays `City MCP`. That name is what the squad panel shows; it is the client that opened the connection, not a signed identity. The row text is the outcome (preview / saved revision / restored default / not applied), plus part count, height, and any design warnings — not `set ok ca_…`.

## Transport

Same PluginHost bus as construction / ghost / fail-flash (`host.sock` under `state/plugins/city-buildings/`). Three **separate** last-event mailboxes so they cannot overwrite each other:

| File | Payload | City CustomEvent |
|---|---|---|
| `notify.json` | `CityEntityChanged` persist `set`/`reset` | `__AV_PLUGIN_ENTITY_CHANGED__` |
| `edit.json` | `CityEntityChanged` `preview`/`reject` | `__AV_PLUGIN_ENTITY_CHANGED__` |
| `squad.json` | IM envelope v:1 | `__AV_PLUGIN_SQUAD_EVENT__` |

Construction notify always runs first on persist. IM fanout is best-effort and must not fail the MCP write.

## `im_publish`

MCP tool (writes need `--allow-local-writes`). Session auth is the same resolve as building tools (`sr_…` or `ca_…`). Agents may send only `chat` / `claim` / `release`. Server rejects `preview` / `set` / `reset` / `reject` / `observe` — those are not Agent-reported.

## Soft claim lock

SQLite table `claims` in the City-owned store (`overrides.sqlite`):

`PRIMARY KEY (session_id, asset_ref)` plus `agent_id`, `agent_name`, `expires_at`, `updated_at`.

- Stealable: another agent's `claim` emits `release` `stolen` then takes the row.
- TTL: default 90s (15–900). Expired claims emit `release` `ttl` on the next claim, or drop from the active list.
- `set_won`: a successful `set_building_model` / `reset_building` clears the row and fans out `release` `set_won`.
- CAS `expected_revision` on set is unchanged. A claim is not a hard lock.

## City HUD

Left squad timeline + optional kill-feed strip. Kind visibility is fixed in code (write-related on, chat/observe off, reset on like set); there is no local preference and no kind picker. Building chips call `engine.focusBuilding(asset_ref)`. Active claims tint the lot (amber pad). Ghost / fail-flash from PR #12 are unchanged; design-coherence rejects (`disconnected_part`, `massing_drift`) use the same fail-flash. Soft `data.warnings` do not flash. Fanout envelopes that carry `payload.revision` keep a per-`asset_ref` watermark: a lower (or equal-but-older) revision is a no-op and never mutates a sibling lot. Soft `claim`/`release` stay last-event-wins and do not invent a revision.

## Not in this phase

`get_squad_feed`, verbose `observe`, agent labels, decal/graffiti, world chat, hard locks, OT.

## Try it

```bash
python3 scripts/verify-city-building-mcp.py
node scripts/verify-city-squad-im.mjs
```

With City open and `agent-vitals data-mcp serve --allow-local-writes`:

1. `im_publish` `kind=claim` → sidebar row + lot tint.
2. `preview_building` → ghost **and** `kind=preview` envelope.
3. Compliance / detail-regression reject → fail-flash **and** `kind=reject` envelope.
4. Click the building chip → camera focuses that lot.

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"im_publish","arguments":{"session_id":"sr_…","agent_id":"nano","agent_name":"Nano","kind":"claim","payload":{"asset_ref":"ca_…","ttl_sec":90}}}}
```
