#!/usr/bin/env node
// Frontend-only browser preparation; no Rust build or real-user data access.
import { execFileSync } from "node:child_process";
import { buildOfficialPlugins } from "./official-plugins.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("npm", ["run", "build:react"], { cwd: path.join(repo, "apps/desktop/ui-dev"), stdio: "inherit" });
buildOfficialPlugins();
console.log("Browser preview ready: official plugin assets packaged; no Rust required.");
