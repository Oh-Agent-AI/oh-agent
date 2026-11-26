import test from "node:test";
import assert from "node:assert/strict";
import { formatInstalledPackage, parseInstallResult, parseInstalledPackages } from "../src/installedContent.ts";

const base = { packageId: "egypt-desert", version: "1.0.0", contentDigest: `sha256:${"b".repeat(64)}`, fileCount: 4, byteLength: 1024, installedAtMs: 1794640000000 };

test("parses bounded installed-package lists and install results", () => {
  const list = parseInstalledPackages({ packages: [base] });
  assert.ok(list);
  assert.equal(list.length, 1);
  assert.match(formatInstalledPackage(list[0]), /仅本机安装/);
  const installed = parseInstallResult({ ...base, alreadyInstalled: true });
  assert.ok(installed);
  assert.equal(installed.alreadyInstalled, true);
});

test("rejects extra fields, bad digests and unbounded counts", () => {
  assert.equal(parseInstalledPackages({ packages: [{ ...base, path: "/secret" }] }), null);
  assert.equal(parseInstalledPackages({ packages: [{ ...base, contentDigest: "sha256:short" }] }), null);
  assert.equal(parseInstalledPackages({ packages: [{ ...base, byteLength: 140 * 1024 * 1024 + 1 }] }), null);
  assert.equal(parseInstallResult({ ...base }), null);
  assert.equal(parseInstallResult({ ...base, alreadyInstalled: "no" }), null);
});
