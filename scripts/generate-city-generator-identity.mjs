import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../apps/agent-city/ui", import.meta.url)));
const target = path.join(root, "src/engine/generatorIdentity.generated.ts");
const sources = [path.join(root, "src/engine/cityLayout.ts"), path.join(root, "src/engine/generatorVersion.ts")];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) sources.push(full);
  }
}
collect(path.join(root, "src/engine/planner"));
sources.sort();
const hash = createHash("sha256");
for (const source of sources) {
  hash.update(path.relative(root, source).split(path.sep).join("/"));
  hash.update("\0");
  hash.update(fs.readFileSync(source));
  hash.update("\0");
}
const digest = `sha256:${hash.digest("hex")}`;
const output = `export const CITY_GENERATOR_ID = "city-layout-v1";\nexport const CITY_GENERATOR_CONTRACT_VERSION = 1 as const;\nexport const CITY_GENERATOR_CODE_DIGEST = "${digest}";\n`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
    throw new Error("generatorIdentity.generated.ts is stale; run node scripts/generate-city-generator-identity.mjs");
  }
} else {
  fs.writeFileSync(target, output);
  console.log(digest);
}
