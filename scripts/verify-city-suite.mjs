#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { selectStages, typecheck, build } from "./city-kit/verification.mjs";
import { repo, kitStats, snapshotCachedPlans, assertCachedPlansUnchanged } from "./city-kit/index.mjs";

const argv = process.argv.slice(2);
const mode = argv.shift() ?? "full";
const group = mode === "module" ? argv.shift() : undefined;
let reportPath;
try {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-cache") process.env.CITY_KIT_NO_CACHE = "1";
    else if (argv[i] === "--report" && argv[i + 1]) reportPath = path.resolve(argv[++i]);
    else throw new Error("Unknown or incomplete option: " + argv[i]);
  }
  const selected = selectStages(mode, group);
  const tasks = [typecheck, { id: "verification-harness", file: "verify-city-verification.mjs", env: { CITY_KIT_NO_CACHE: "0" } },
    ...selected, ...(mode === "full" ? [build] : [])];
  const rows = [];
  const start = performance.now();
  const child = (task) => new Promise((resolve, reject) => {
    const proc = spawn(task.command ?? process.execPath, task.args ?? [path.join(repo, "scripts", task.file)], {
      cwd: task.cwd ?? repo, env: { ...process.env, ...task.env }, stdio: "inherit",
    });
    proc.once("error", reject);
    proc.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(task.id + " exited " + (signal ?? code))));
  });
  for (const task of tasks) {
    const began = performance.now();
    const before = kitStats();
    console.log("\n[city " + mode + "] START " + task.id);
    let error;
    const prior = Object.fromEntries(Object.keys(task.env ?? {}).map((k) => [k, process.env[k]]));
    try {
      if (task.shared) {
        const snapshot = snapshotCachedPlans();
        Object.assign(process.env, task.env);
        // Only explicitly audited read-only guards share this process; scene shims and
        // cross-engine/determinism guards remain independent subprocesses.
        await import(pathToFileURL(path.join(repo, "scripts", task.file)).href + "?stage=" + task.id);
        assertCachedPlansUnchanged(snapshot);
      } else await child(task);
    } catch (reason) { error = reason; }
    finally {
      for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const after = kitStats();
    const row = { id: task.id, status: error ? "failed" : "passed", durationMs: Math.round(performance.now() - began),
      execution: task.shared ? "shared-readonly" : "subprocess",
      sharedPlanHits: after.planHits - before.planHits, sharedPlanGenerations: after.planGenerations - before.planGenerations,
      ...(error ? { error: String(error) } : {}) };
    rows.push(row);
    console.log("[city " + mode + "] " + row.status.toUpperCase() + " " + row.id + " " + row.durationMs + "ms");
    if (error) { process.exitCode = 1; break; } // Fast feedback; unrun guards are not claimed passed.
  }
  const result = { mode, group, cache: process.env.CITY_KIT_NO_CACHE !== "1", selected: tasks.map((t) => t.id),
    completed: rows.length, complete: rows.length === tasks.length, durationMs: Math.round(performance.now() - start),
    sharedKit: kitStats(), stages: rows };
  console.log("\n[city] " + JSON.stringify(result));
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  if (!result.complete || rows.some((r) => r.status === "failed")) process.exitCode = 1;
} catch (error) { console.error(String(error)); process.exitCode = 1; }
