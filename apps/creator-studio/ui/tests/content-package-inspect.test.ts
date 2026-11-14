import test from "node:test";
import assert from "node:assert/strict";
import { formatWorldPackageInspection, parseWorldPackageInspection } from "../src/contentPackageInspect.ts";

const valid = { kind: "city-world", inspectionId: "content-inspection-1794640000000-1", packageId: "egypt-desert", version: "1.2.0",
  contentDigest: `sha256:${"a".repeat(64)}`, fileCount: 4, installable: false,
  checks: { integrity: "passed", semantics: "unchecked", compatibility: "unchecked", publisher: "unverified", installation: "unavailable" } };

test("accepts the host's bounded, explicitly non-installable inspection shape", () => {
  const parsed = parseWorldPackageInspection(valid);
  assert.ok(parsed);
  assert.equal(parsed.packageId, "egypt-desert");
  assert.match(formatWorldPackageInspection(parsed), /完整性通过.*不可安装/);
});

test("rejects installable claims, extra fields, bad digests and missing checks", () => {
  assert.equal(parseWorldPackageInspection({ ...valid, installable: true }), null);
  assert.equal(parseWorldPackageInspection({ ...valid, path: "/Users/secret/world.json" }), null);
  assert.equal(parseWorldPackageInspection({ ...valid, contentDigest: "sha256:short" }), null);
  assert.equal(parseWorldPackageInspection({ ...valid, checks: { integrity: "passed" } }), null);
  assert.equal(parseWorldPackageInspection({ ...valid, packageId: "" }), null);
  assert.equal(parseWorldPackageInspection({ ...valid, inspectionId: "guess" }), null);
  assert.equal(parseWorldPackageInspection(null), null);
});
