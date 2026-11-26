import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Executable boundary guard. The public API is meant to be linkable into a
 * browser bundle and into a wasm/headless host; one accidental `import "three"`
 * or DOM/Node reference would silently make the package host-specific — the
 * exact failure this repo already guards in its Rust crates.
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const srcRoot = path.join(packageRoot, "src");

const sourceFiles = (directory: string): string[] =>
  fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath ?? directory, entry.name));

const files = sourceFiles(srcRoot);

test("the SDK source imports no renderer, framework, Tauri, Node or sibling app code", () => {
  const forbidden = [
    /from\s+["']three["']/,
    /from\s+["']react["']/,
    /from\s+["']react-dom["']/,
    /from\s+["']@tauri/,
    /from\s+["']node:/,
    /from\s+["']@agent-vitals/,
    /\.\.\/\.\.\/apps\//,
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${path.relative(packageRoot, file)} must not match ${pattern}`,
      );
    }
  }
});

test("simulation code never reads the wall clock", () => {
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(
      /Date\.now\(/.test(source),
      false,
      `${path.relative(packageRoot, file)} must take time from the injected clock`,
    );
    assert.equal(
      /performance\.now\(/.test(source),
      false,
      `${path.relative(packageRoot, file)} must take time from the injected clock`,
    );
  }
});

test("the public API layer does not depend on host or testing internals", () => {
  for (const file of files.filter((value) => value.includes(`${path.sep}api${path.sep}`))) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes('"../host'), false, `${path.basename(file)} must not import the host`);
    assert.equal(source.includes('"../testing'), false, `${path.basename(file)} must not import the test harness`);
  }
});

test("the protocol layer depends on neither the API nor the host", () => {
  for (const file of files.filter((value) => value.includes(`${path.sep}protocol${path.sep}`))) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(source.includes('"../host'), false, `${path.basename(file)} must not import the host`);
    assert.equal(source.includes('"../api'), false, `${path.basename(file)} must not import the game API`);
  }
});

test("the package exposes the four documented entry points", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [".", "./host", "./protocol", "./testing"]);
});
