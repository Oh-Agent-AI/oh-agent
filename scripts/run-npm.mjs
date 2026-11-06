import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function runNpm(args, options = {}) {
  if (process.platform !== "win32") return execFileSync("npm", args, options);
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...((process.env.PATH || "").split(path.delimiter).map(dir => path.join(dir, "node_modules/npm/bin/npm-cli.js")))];
  const cli = candidates.find(file => file && /npm-cli\.js$/i.test(file) && existsSync(file));
  if (!cli) throw new Error("Cannot locate npm-cli.js; install Node.js with npm or run through npm");
  return execFileSync(process.execPath, [cli, ...args], options);
}
