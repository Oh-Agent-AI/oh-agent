import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const server = new URL("../../mcp/mecha-mcp.mjs", import.meta.url);
const register = new URL("../../../../scripts/mecha-ts-register.mjs", import.meta.url);

test("stdio MCP exposes and executes the v1.5 combat tools", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", register.pathname, server.pathname], { cwd: new URL("../", import.meta.url).pathname, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "", id = 0, pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    const timer = setTimeout(() => { if (pending.delete(requestId)) reject(new Error(`${method} timed out`)); }, 20000);
    timer.unref();
  });
  try {
    const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "mecha-combat");
    const tools = await request("tools/list");
    assert.ok(tools.result.tools.some(tool => tool.name === "mecha_new_match"));
    assert.ok(tools.result.tools.some(tool => tool.name === "mecha_auto_battle"));
    const created = await request("tools/call", { name: "mecha_new_match", arguments: { mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }] } });
    const match = JSON.parse(created.result.content[0].text);
    assert.equal(match.state.phase, "player_plan");
    const legal = await request("tools/call", { name: "mecha_legal_actions", arguments: { matchId: match.matchId, mech: "Assault" } });
    assert.ok(JSON.parse(legal.result.content[0].text).actions.some(action => action.kind === "charge"));
    const before = match.state.revision;
    const ended = await request("tools/call", { name: "mecha_end_turn", arguments: { matchId: match.matchId } });
    const after = JSON.parse(ended.result.content[0].text);
    assert.ok(after.state.revision > before);
  } finally {
    child.stdin.end(); child.kill();
  }
});
