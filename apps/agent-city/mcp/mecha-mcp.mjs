#!/usr/bin/env node
// Minimal stdio MCP server for exercising v1.5 combat logic. No network, no UI.
import readline from "node:readline";
import { createMatch, bossPrepare } from "../ui/src/game/mecha/rules.ts";
import { SequentialTurn } from "../ui/src/game/mecha/sequentialTurn.ts";
import { runSequentialAutoBattle } from "../ui/src/game/mecha/ai/sequentialAutoBattle.ts";
import { baupEnemyPlanner } from "../ui/src/game/mecha/enemy/plannerV2.ts";
import { legalActions } from "../ui/src/game/mecha/combat.ts";
import { applyDeployPlan, deployableCells } from "../ui/src/game/mecha/deployment.ts";
import { MECH_IDS, occupant, pathDistance, moveBudget } from "../ui/src/game/mecha/board.ts";

const PROTOCOL = "2024-11-05";
const sessions = new Map();
let nextSession = 0;
let commandSerial = 0;

const ok = text => ({ content: [{ type: "text", text: JSON.stringify(text) }] });
const fail = (message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }] });

function summary(session) {
  const state = session.turn?.snapshot().match ?? session.state;
  const units = state.mechs.map(mech => ({ id: mech.id, pos: mech.pos, hp: mech.hp, cd: mech.cd, statuses: state.statusEncounter?.statuses.filter(status => status.target === mech.id) ?? [] }));
  return {
    matchId: session.id, ruleset: state.ruleset, phase: state.phase, turn: state.turn, revision: state.revision, outcome: state.outcome,
    units, boss: { hp: state.boss.hp, anchor: state.boss.anchor, intent: state.boss.intent },
    raiders: state.raiders.map(raider => ({ id: raider.id, pos: raider.pos, hp: raider.hp })),
    buildings: state.buildings.map(building => ({ id: building.id, hp: building.hp })),
    canUndo: session.turn?.canUndo() ?? false,
  };
}

function sessionOf(args) {
  const session = sessions.get(args.matchId);
  if (!session) throw new Error("match_not_found");
  return session;
}

function execute(args, command) {
  const session = sessionOf(args);
  if (!session.turn) throw new Error("deployment_required");
  const revision = session.turn.snapshot().match.revision;
  const result = session.turn.execute({ ...command, id: `mcp-${++commandSerial}`, revision });
  if (!result.ok) return fail(result.reason, { revision });
  session.state = result.snapshot.match;
  return ok({ ok: true, revision: result.snapshot.match.revision, events: result.events.map(event => event.type), state: summary(session) });
}

const tools = [
  { name: "mecha_new_match", description: "Create a local v1.5 match from a scenario (deployment or player_plan).",
    inputSchema: { type: "object", properties: {
      preset: { type: "string" }, script: { type: "string" }, ruleset: { type: "string", enum: ["mecha-v1.5", "mecha-v1.4"] },
      deployment: { type: "boolean" }, monsterSpecies: { type: "string" },
      mechs: { type: "array", items: { type: "object", properties: { id: { type: "string" }, pos: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }, required: ["id", "pos"] } },
      boss: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
      raiders: { type: "array", items: { type: "object" } }, buildings: { type: "array", items: { type: "object" } },
      covers: { type: "array", items: { type: "object" } }, obstacles: { type: "array", items: { type: "object" } },
      difficulty: { type: "string" },
      waves: { type: "object", properties: { count: { type: "number" }, raidersPerWave: { type: "number" }, spawns: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } }, required: ["count", "spawns"] },
    } } },
  { name: "mecha_deploy", description: "Finish deployment with explicit placements and start the first player turn.",
    inputSchema: { type: "object", required: ["matchId", "placements"], properties: { matchId: { type: "string" }, placements: { type: "array", items: { type: "object", properties: { mechId: { type: "string" }, pos: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }, required: ["mechId", "pos"] } } } } },
  { name: "mecha_state", description: "Read a compact authoritative state.", inputSchema: { type: "object", required: ["matchId"], properties: { matchId: { type: "string" } } } },
  { name: "mecha_legal_actions", description: "List legal actions and move destinations for one mech.", inputSchema: { type: "object", required: ["matchId", "mech"], properties: { matchId: { type: "string" }, mech: { type: "string" } } } },
  { name: "mecha_move", description: "Move one mech.", inputSchema: { type: "object", required: ["matchId", "mech", "to"], properties: { matchId: { type: "string" }, mech: { type: "string" }, to: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } } },
  { name: "mecha_act", description: "Resolve one action (melee/shoot/charge/pierce/repair/skip).", inputSchema: { type: "object", required: ["matchId", "mech", "action"], properties: { matchId: { type: "string" }, mech: { type: "string" }, action: { type: "object" } } } },
  { name: "mecha_undo", description: "Undo the last move if available.", inputSchema: { type: "object", required: ["matchId"], properties: { matchId: { type: "string" } } } },
  { name: "mecha_end_turn", description: "End the player turn and resolve the enemy phase.", inputSchema: { type: "object", required: ["matchId"], properties: { matchId: { type: "string" } } } },
  { name: "mecha_auto_battle", description: "Run the v1.5 EvE harness (squad policy vs enemy planner) until outcome or step limit.", inputSchema: { type: "object", required: ["matchId"], properties: { matchId: { type: "string" }, maxSteps: { type: "number" }, difficulty: { type: "string", enum: ["greedy", "coordinated", "beam"] }, enemyPolicy: { type: "string", enum: ["scripted", "baup"] } } } },
];

function callTool(name, args) {
  if (name === "mecha_new_match") {
    const id = `match-${++nextSession}`;
    const state = createMatch({
      preset: args.preset ?? "covers_sparse_mid", script: args.script ?? "stationary_smash",
      ruleset: args.ruleset ?? "mecha-v1.5", deployment: args.deployment === true,
      ...(args.mechs ? { mechs: args.mechs } : {}), ...(args.boss ? { boss: args.boss } : {}),
      ...(args.raiders ? { raiders: args.raiders } : {}), ...(args.buildings ? { buildings: args.buildings } : {}),
      ...(args.covers ? { covers: args.covers } : {}), ...(args.obstacles ? { obstacles: args.obstacles } : {}),
      ...(args.difficulty ? { difficulty: args.difficulty } : {}),
      ...(args.waves ? { waves: args.waves } : {}),
      ...(args.monsterSpecies ? { monsterContent: { speciesId: args.monsterSpecies, contentVersion: 1 } } : {}),
    });
    const session = { id, state, turn: null, initial: null, placements: null };
    if (state.phase === "deployment") {
      session.initial = structuredClone(state);
      session.placements = deployableCells(state);
    } else {
      bossPrepare(state);
      session.initial = structuredClone(state);
      session.turn = new SequentialTurn(state);
    }
    sessions.set(id, session);
    return ok({ matchId: id, deploymentCells: session.placements, state: summary({ ...session, turn: session.turn }) });
  }
  if (name === "mecha_deploy") {
    const session = sessionOf(args);
    if (!session.initial || session.turn) throw new Error("not_deployment");
    const result = applyDeployPlan(session.initial, { revision: session.initial.revision, placements: args.placements });
    if (!result.ok) return fail("invalid_deployment", { fault: result.fault });
    session.state = result.state; session.turn = new SequentialTurn(result.state);
    return ok(summary(session));
  }
  if (name === "mecha_state") return ok(summary(sessionOf(args)));
  if (name === "mecha_legal_actions") {
    const session = sessionOf(args), state = session.turn?.snapshot().match ?? session.state;
    const unit = state.mechs.find(mech => mech.id === args.mech);
    if (!unit) return fail("unknown_mech");
    const moves = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      if (occupant(state, { x, y }) !== "empty") continue;
      const distance = pathDistance(state, unit.pos, { x, y }, args.mech, { alliesPass: true });
      if (distance !== null && distance <= moveBudget(args.mech)) moves.push({ x, y, distance });
    }
    return ok({ actions: legalActions(state, args.mech), moves });
  }
  if (name === "mecha_move") return execute(args, { kind: "move", mech: args.mech, to: args.to });
  if (name === "mecha_act") return execute(args, { kind: "act", mech: args.mech, action: args.action });
  if (name === "mecha_undo") return execute(args, { kind: "undo" });
  if (name === "mecha_end_turn") return execute(args, { kind: "end", confirmUnused: true });
  if (name === "mecha_auto_battle") {
    const session = sessionOf(args);
    const maxSteps = Math.min(500, Math.max(1, args.maxSteps ?? 100));
    const difficulty = args.difficulty === "greedy" || args.difficulty === "coordinated" ? args.difficulty : "beam";
    const enemy = args.enemyPolicy === "baup" ? baupEnemyPlanner : undefined;
    const result = runSequentialAutoBattle(session.state, { maxSteps, maxTurns: 15, difficulty, ...(enemy ? { enemy } : {}) });
    session.state = result.state;
    session.turn = result.state.phase === "player_plan" ? new SequentialTurn(result.state) : null;
    return ok({ steps: result.steps, outcome: result.outcome, reason: result.reason, fault: result.fault, state: summary(session) });
  }
  throw new Error("unknown_tool");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // notifications
  let response;
  try {
    if (message.method === "initialize") response = { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "mecha-combat", version: "1.0.0" } };
    else if (message.method === "ping") response = {};
    else if (message.method === "tools/list") response = { tools };
    else if (message.method === "tools/call") response = callTool(message.params?.name, message.params?.arguments ?? {});
    else throw Object.assign(new Error("method_not_found"), { code: -32601 });
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response }) + "\n");
});
