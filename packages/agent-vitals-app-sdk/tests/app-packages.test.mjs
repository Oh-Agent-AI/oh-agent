import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonical, digest, installationBudget, LIMITS, parseSignedJson, signatureMessage, validateShape,
  verifyFileRecords, verifyIndex, verifyManifest, verifyRelease, verifyTrust } from "../../../scripts/app-package-contracts.mjs";
import { repo, requireSdk } from "../../../scripts/app-contract-support.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(repo, "fixtures/app-contracts/app-manifest-v1.json"), "utf8"));
const target = { platform: "macos", architecture: "aarch64", team_id: "FIXTURE001", harness_version: "1.4.0", broker_version: 1 };
const root = generateKeyPairSync("ed25519"), app = generateKeyPairSync("ed25519");
const roots = new Map([["fixture-root", root.publicKey]]);
function signed(kind, payload, keyId = "fixture-release", privateKey = app.privateKey) {
  const envelope = { payload: structuredClone(payload), signature: { algorithm: "Ed25519", key_id: keyId, value: "" } };
  envelope.signature.value = sign(null, signatureMessage(kind, envelope), privateKey).toString("base64url");
  return envelope;
}
function trustPayload() {
  return { trust_schema_version: 1, source_id: "fixture-source", trust_sequence: 1,
    download_prefix: "https://packages.example.invalid/apps/", revoked_archive_sha256: [],
    keys: [{ key_id: "fixture-release", publisher: "fixture-publisher", platform_team_id: "FIXTURE001",
      public_key: app.publicKey.export({ format: "jwk" }), purposes: ["index", "release"],
      valid_from_sequence: 1, valid_until_sequence: null, revoked: false }] };
}
const policy = verifyTrust(signed("trust", trustPayload(), "fixture-root", root.privateKey), roots);
function releasePayload() {
  const hash = "b".repeat(64);
  return { release_schema_version: 1, source_id: "fixture-source", release_sequence: 1,
    manifest: structuredClone(manifest), manifest_sha256: digest(manifest),
    archive: { format: "zip", url: policy.download_prefix + hash + ".zip", sha256: hash, size_bytes: 123 } };
}
function indexPayload() {
  return { index_schema_version: 1, source_id: "fixture-source", catalog_sequence: 1, trust_sequence: 1,
    published_at_ms: 100, expires_at_ms: 1000, entries: [signed("release", releasePayload())] };
}

test("canonical input is strict, integer-only and UTF-16 ordered", () => {
  assert.equal(canonical({ b: [1, true, null], a: "汉字" }), '{"a":"汉字","b":[1,true,null]}');
  assert.equal(canonical({ "\ufffd": 1, "\ud83d\ude00": 2 }), '{"😀":2,"�":1}');
  assert.equal(canonical(parseSignedJson(' { "b": 2, "a": 1 } ')), '{"a":1,"b":2}');
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"v":9007199254740992}',
    '{"v":1.5}', '{"v":1.0000000000000001}', '{"v":9007199254740991.1}', '{"v":1e3}',
    '{"v":-0}', '{"v":"\\ud800"}', '{"v":true}false', '[1,]', '{"a":1,}']) {
    assert.throws(() => parseSignedJson(text), text);
  }
  assert.throws(() => parseSignedJson(Buffer.from([0xff])), /encoded data/);
  assert.throws(() => parseSignedJson(" ".repeat(LIMITS.index + 1)), /budget/);
  assert.throws(() => parseSignedJson("[".repeat(66) + "0" + "]".repeat(66)), /depth/);
  assert.notEqual(canonical("é"), canonical("e\u0301"));
});

test("root-signed policy authorizes domains and cannot lose revocations", () => {
  assert.equal(policy.source_id, "fixture-source");
  assert.throws(() => verifyTrust(signed("trust", trustPayload()), roots), /unknown trust root/);
  const revoked = trustPayload(); revoked.trust_sequence = 2; revoked.keys[0].revoked = true;
  revoked.revoked_archive_sha256 = ["b".repeat(64)];
  const current = verifyTrust(signed("trust", revoked, "fixture-root", root.privateKey), roots, policy);
  const undone = trustPayload(); undone.trust_sequence = 3;
  assert.throws(() => verifyTrust(signed("trust", undone, "fixture-root", root.privateKey), roots, current), /unrevocation/);
  assert.throws(() => verifyTrust(signed("trust", trustPayload(), "fixture-root", root.privateKey), roots, current), /rollback/);
  const removed = structuredClone(revoked); removed.trust_sequence = 3; removed.keys = [];
  assert.throws(() => verifyTrust(signed("trust", removed, "fixture-root", root.privateKey), roots, current), /removal/);
  const rebound = structuredClone(revoked); rebound.trust_sequence = 3; rebound.keys[0].platform_team_id = "OTHER00001";
  assert.throws(() => verifyTrust(signed("trust", rebound, "fixture-root", root.privateKey), roots, current), /rebinding/);
  const duplicate = trustPayload(); duplicate.keys.push({ ...duplicate.keys[0], revoked: true });
  assert.throws(() => verifyTrust(signed("trust", duplicate, "fixture-root", root.privateKey), roots), /duplicate key/);
});

test("release verifies publisher, manifest, source, signing domain and immutable URL", () => {
  const release = signed("release", releasePayload());
  assert.equal(verifyRelease(release, policy, target).manifest.id, "agent-city");
  const mutated = structuredClone(release); mutated.payload.manifest.permissions.controls = [];
  assert.throws(() => verifyRelease(mutated, policy, target), /signature/);
  assert.throws(() => verifyRelease(signed("index", releasePayload()), policy, target), /signature/);
  assert.throws(() => verifyRelease(signed("release", releasePayload(), "unknown"), policy), /untrusted/);
  for (const field of ["publisher", "signing_key_id"]) {
    const changed = releasePayload(); changed.manifest[field] = "fake"; changed.manifest_sha256 = digest(changed.manifest);
    assert.throws(() => verifyRelease(signed("release", changed), policy), /identity/);
  }
  for (const url of ["https://evil.example.invalid/apps/" + "b".repeat(64) + ".zip",
    policy.download_prefix + "b".repeat(64) + ".zip?secret=1", policy.download_prefix + "../" + "b".repeat(64) + ".zip",
    policy.download_prefix + "latest.zip", "https://user@packages.example.invalid/apps/" + "b".repeat(64) + ".zip"]) {
    const changed = releasePayload(); changed.archive.url = url;
    assert.throws(() => verifyRelease(signed("release", changed), policy), /URL/);
  }
  const revoked = structuredClone(policy); revoked.keys[0].revoked = true;
  assert.throws(() => verifyRelease(release, revoked), /untrusted/);
  const revokedRelease = structuredClone(policy); revokedRelease.revoked_archive_sha256.push(release.payload.archive.sha256);
  assert.throws(() => verifyRelease(release, revokedRelease), /revoked release/);
  const oversize = releasePayload(); oversize.archive.size_bytes = LIMITS.archive + 1;
  assert.throws(() => verifyRelease(signed("release", oversize), policy), /structure/);
});

test("index watermark advances only after every signature and semantic check", () => {
  const index = signed("index", indexPayload());
  const high = verifyIndex(index, policy, null, 200);
  assert.deepEqual(verifyIndex(index, policy, high, 200), high);
  const before = structuredClone(high);
  const next = indexPayload(); next.catalog_sequence = 2; next.entries[0].payload.manifest.version = "9.0.0";
  assert.throws(() => verifyIndex(signed("index", next), policy, high, 200), /signature/);
  assert.deepEqual(high, before);
  const fork = indexPayload(); fork.expires_at_ms++;
  assert.throws(() => verifyIndex(signed("index", fork), policy, high, 200), /fork/);
  const advanced = indexPayload(); advanced.catalog_sequence = 2;
  const high2 = verifyIndex(signed("index", advanced), policy, high, 200);
  assert.throws(() => verifyIndex(index, policy, high2, 200), /replay/);
  assert.throws(() => verifyIndex(index, policy, high, 1000), /expired/);
  const duplicate = indexPayload(); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => verifyIndex(signed("index", duplicate), policy, null, 200));
  // Catalog can list other architectures: eligibility is checked at install/start, not by rejecting the whole index.
  const multi = indexPayload(); const intel = releasePayload(); intel.manifest.architecture = "x86_64";
  intel.manifest_sha256 = digest(intel.manifest); multi.entries.push(signed("release", intel));
  assert.equal(verifyIndex(signed("index", multi), policy, null, 200).sequence, 1);
});

test("manifest closes file/permission sets and rejects unsafe or incompatible declarations", () => {
  assert.equal(verifyManifest(manifest, target), 9);
  for (const pathname of ["/tmp/file", "../file", "AgentCity.app/../file", "AgentCity.app//file", "AgentCity.app\\file", "other.app/file"]) {
    const bad = structuredClone(manifest); bad.resources[0].path = pathname;
    assert.throws(() => verifyManifest(bad, target));
  }
  const collision = structuredClone(manifest);
  collision.resources.push({ ...collision.resources[0], path: collision.resources[0].path.toUpperCase() });
  assert.throws(() => verifyManifest(collision), /outside bundle or resource collision/);
  const missing = structuredClone(manifest); missing.resources.shift();
  assert.throws(() => verifyManifest(missing), /executable/);
  for (const parent of [manifest.resources[0].path, manifest.resources[0].path.toUpperCase().replace("AGENTCITY.APP", "AgentCity.app")]) {
    const ancestor = structuredClone(manifest);
    ancestor.resources.push({ ...ancestor.resources[0], path: parent + "/child" });
    assert.throws(() => verifyManifest(ancestor), /ancestor collision/);
  }
  const trailing = structuredClone(manifest); trailing.resources[0].sha256 += "\n";
  assert.throws(() => verifyManifest(trailing), /structure/);
  const unlicensed = structuredClone(manifest); unlicensed.resources[0].license_id = "unknown";
  assert.throws(() => verifyManifest(unlicensed), /unlicensed/);
  const permission = structuredClone(manifest); permission.permissions.projections = [];
  assert.throws(() => verifyManifest(permission), /required projection/);
  const unknown = structuredClone(manifest); unknown.permissions.controls.push("shell.exec");
  assert.throws(() => verifyManifest(unknown), /structure/);
  const over = structuredClone(manifest); over.resources[0].size_bytes = LIMITS.expanded;
  assert.throws(() => verifyManifest(over), /budget/);
  assert.throws(() => verifyManifest(manifest, { ...target, architecture: "x86_64" }), /platform/);
  assert.throws(() => verifyManifest(manifest, { ...target, harness_version: "2.0.0" }), /incompatible/);
  assert.throws(() => verifyManifest(manifest, { ...target, broker_version: 2 }), /incompatible/);
});

test("file-record closure rejects changed bytes, extra files, missing files and links", () => {
  const records = manifest.resources.map((file) => ({ ...file, type: "regular" }));
  verifyFileRecords(manifest, records);
  for (const mutate of [(rows) => rows.pop(), (rows) => rows.push({ ...rows[0], path: "unlisted" }),
    (rows) => { rows[0].sha256 = "c".repeat(64); }, (rows) => { rows[0].type = "symlink"; },
    (rows) => { rows[0].size_bytes++; }, (rows) => { rows[0].mode = "file"; },
    (rows) => { rows[1] = { ...rows[0] }; }]) {
    const bad = structuredClone(records); mutate(bad);
    assert.throws(() => verifyFileRecords(manifest, bad));
  }
});

test("data catalog v1 remains strict and is never an app trust channel", () => {
  const Ajv = requireSdk("ajv/dist/2020.js").default;
  const schema = JSON.parse(fs.readFileSync(path.join(repo, "docs/schemas/catalog-index-v1.json"), "utf8"));
  const validate = new Ajv({ strict: true }).compile(schema);
  const empty = { index_schema_version: 1, catalog_sequence: 1, published_at: "2026-10-03T00:00:00Z", entries: [] };
  assert(validate(empty));
  assert(!validate({ ...empty, app_signature: "fake" }));
  assert(!validate(signed("index", indexPayload())));
  assert.throws(() => validateShape("index", empty), /structure/);
});

test("retained rollback objects count toward the final and staging disk budgets", () => {
  const request = { retainedBytes: 100, archiveBytes: 123, expandedBytes: 9, controlBytes: 1000, availableBytes: 100000000 };
  assert.equal(installationBudget(request).finalBytes, 1109);
  assert.throws(() => installationBudget({ ...request, retainedBytes: LIMITS.installed }), /disk budget/);
  assert.throws(() => installationBudget({ ...request, availableBytes: 1000 }), /disk budget/);
  assert.throws(() => installationBudget({ ...request, retainedBytes: Number.MAX_SAFE_INTEGER + 1 }), /measurement/);
});
