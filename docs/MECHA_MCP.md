# Mecha Combat MCP (local testing)

`apps/agent-city/mcp/mecha-mcp.mjs` is a stdio MCP server for exercising the
authoritative v1.5 command engine without the UI, Three.js or a relay. It is
local-only: no network, no credentials, no persistence between processes.

## Start

From the repo root:

```bash
node --experimental-strip-types \
  --import ./scripts/mecha-ts-register.mjs \
  ./apps/agent-city/mcp/mecha-mcp.mjs
```

or from `apps/agent-city/ui`:

```bash
npm run mcp:mecha
```

An MCP client entry (`<repo>` is this checkout):

```json
{
  "mcpServers": {
    "mecha-combat": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "--import", "<repo>/scripts/mecha-ts-register.mjs",
        "<repo>/apps/agent-city/mcp/mecha-mcp.mjs"
      ]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `mecha_new_match` | Create a v1.5 match from a scenario; `deployment: true` starts in deployment |
| `mecha_deploy` | Apply placements and start the first player turn |
| `mecha_state` | Compact authoritative state: phase, turn, revision, outcome, units, boss, raiders, buildings |
| `mecha_legal_actions` | Legal actions plus reachable move cells for one mech |
| `mecha_move` / `mecha_act` / `mecha_undo` / `mecha_end_turn` | Submit one command and resolve immediately |
| `mecha_auto_battle` | Run the deterministic command policy until outcome or `maxSteps` |

`mecha_new_match` accepts `preset`, `script`, `ruleset`, `deployment`,
`monsterSpecies`, `mechs`, `boss`, `raiders`, `buildings`, `covers`,
`obstacles` and `difficulty`; omitted fields use the same defaults as
`createMatch`.

## Example

```json
{"tool":"mecha_new_match","arguments":{"mechs":[{"id":"Assault","pos":{"x":3,"y":1}}]}}
{"tool":"mecha_legal_actions","arguments":{"matchId":"match-1","mech":"Assault"}}
{"tool":"mecha_act","arguments":{"matchId":"match-1","mech":"Assault","action":{"kind":"charge","target":"boss"}}}
{"tool":"mecha_end_turn","arguments":{"matchId":"match-1"}}
```

Every mutation is applied to a real `SequentialTurn`; rejected commands return
`isError` with the engine's reason (`stale_revision`, `invalid_action`, ...).
The server keeps matches in memory for the lifetime of the process.
