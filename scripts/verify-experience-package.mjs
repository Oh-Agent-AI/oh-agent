#!/usr/bin/env node
// 验收「P0 · 真正可交付的 Experience」的最小闭环：
//   已发布作品 → 打成自包含体验包 → 装进一个**干净客户端**（空 data home，无 Creator 库）
//   → 无头启动并飞过全部门。
//
// 同时验证包的自校验：改一个字节、改一条 metadata 都必须被拒绝，而不是"尽量跑"。
// 用法：node scripts/verify-experience-package.mjs [--release <id>] [--package <dir>]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const releaseId = process.argv.includes("--release") ? process.argv[process.argv.indexOf("--release") + 1] : "release-2ff764c228f49b54e0d39ee8d90dcce7";
const packageArg = process.argv.includes("--package") ? process.argv[process.argv.indexOf("--package") + 1] : null;
const clean = mkdtempSync(join(tmpdir(), "exp-client-"));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

// 1) 打包（或复用已打好的包）
let source = packageArg;
if (!source) {
  source = join(clean, "build");
  execFileSync(process.execPath, ["--experimental-transform-types", "--import", join(root, "scripts/mecha-ts-register.mjs"),
    join(root, "scripts/build-experience-package.mjs"), "--release", releaseId, "--out", source], { stdio: "pipe" });
  check("build package from the published release", true, source);
}
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));

// 2) 安装到干净客户端：只有一个内容目录，data home 里没有 Creator 库
const clientHome = join(clean, "client-home");
const installed = join(clientHome, "state/creator/content/experience", manifest.experienceId, manifest.version);
cpSync(source, installed, { recursive: true });
check("clean client has no Creator store", !existsSync(join(clientHome, "state/creator/projects.sqlite")));
check("installed package is self-contained", existsSync(join(installed, "manifest.json")) && existsSync(join(installed, "release.json"))
  && existsSync(join(installed, "layout.json")));

// 3) 无头启动（服务进程只拿包目录 + 空 data home）
const child = spawn(process.execPath, ["--experimental-transform-types", "--import", join(root, "scripts/mecha-ts-register.mjs"),
  join(root, "apps/agent-city/mcp/city-game-mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, AV_DATA_HOME: clientHome } });
let buffer = "", serial = 0; const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id);
  }
});
const call = (name, args) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, message => resolve({ ...JSON.parse(message.result.content[0].text), isError: message.result.isError === true }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${name} timeout`)); }, 30_000).unref();
});
const opened = await call("game_open", { experience: installed });
check("launch from package (no store)", !opened.isError, opened.isError ? JSON.stringify(opened.error) : `gates ${opened.gates?.total}`);
if (opened.isError) { child.kill(); rmSync(clean, { recursive: true, force: true }); process.exit(1); }
const ran = await call("game_script", { sessionId: opened.sessionId, script: [{ ticks: 400, input: { throttleUp: true } }] });
check("published gates are flown from the package", ran.gates?.passed === ran.gates?.total && ran.gates.total > 0 && ran.outcome === "success",
  `passed ${ran.gates?.passed}/${ran.gates?.total}, outcome ${ran.outcome}, tick ${ran.tick}, digest ${ran.traceDigest}`);
check("gate geometry came from the package layout", opened.release?.gateSource === "layout-geometry" && !opened.release?.warnings?.includes("gate_radius_defaulted"),
  JSON.stringify(opened.release?.warnings ?? []));
// 已安装模式：Agent 只拿 id+version（不暴露路径），宿主按固定布局解析。
const byId = await call("game_open", { experienceId: manifest.experienceId, experienceVersion: manifest.version, dataHome: clientHome });
check("launch by installed id (no path in the call)", !byId.isError && byId.gates?.total === opened.gates?.total,
  byId.isError ? JSON.stringify(byId.error) : `gates ${byId.gates?.total}`);
if (!byId.isError) {
  const runById = await call("game_script", { sessionId: byId.sessionId, script: [{ ticks: 400, input: { throttleUp: true } }] });
  check("installed-id run matches the directory run", runById.outcome === ran.outcome && runById.traceDigest === ran.traceDigest && runById.gates.passed === ran.gates.passed,
    `outcome ${runById.outcome}, digest ${runById.traceDigest}`);
}
child.kill();

// 4) 反例：改字节 / 改 metadata 必须拒绝
function tampered(name, mutate) {
  const dir = join(clean, `tamper-${name}`);
  cpSync(source, dir, { recursive: true });
  mutate(dir);
  return dir;
}
const byteDir = tampered("byte", dir => writeFileSync(join(dir, "layout.json"), readFileSync(join(dir, "layout.json")).subarray(0, -2)));
const metadataDir = tampered("metadata", dir => {
  const value = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  value.version = "9.9.9";
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(value));
});
async function expectOpenFailure(name, dir, code) {
  const probe = spawn(process.execPath, ["--experimental-transform-types", "--import", join(root, "scripts/mecha-ts-register.mjs"),
    join(root, "apps/agent-city/mcp/city-game-mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, AV_DATA_HOME: clientHome } });
  const result = await new Promise(resolve => {
    let text = ""; probe.stdout.setEncoding("utf8");
    probe.stdout.on("data", chunk => { text += chunk; const at = text.indexOf("\n"); if (at >= 0) resolve(JSON.parse(text.slice(0, at))); });
    probe.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "game_open", arguments: { experience: dir } } })}\n`);
    setTimeout(() => resolve(null), 20_000).unref();
  });
  probe.kill();
  const body = result?.result?.content?.[0]?.text ? JSON.parse(result.result.content[0].text) : null;
  // 错误面有两种形状：`{error:{code}}`（工具层）与 `{error:"code"}`（本服务器的简易面）。
  const reported = typeof body?.error === "string" ? body.error : body?.error?.code;
  check(`tampered ${name} is rejected`, result?.result?.isError === true && reported === code, reported ?? "no error");
}
await expectOpenFailure("bytes", byteDir, "experience_file_digest_mismatch");
await expectOpenFailure("metadata", metadataDir, "experience_digest_mismatch");

rmSync(clean, { recursive: true, force: true });
const failed = checks.filter(item => !item.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nverify-experience-package: ok (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
