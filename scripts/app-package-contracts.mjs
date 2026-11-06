// Pure contract/reference validation. Not a production installer or platform verifier.
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { repo, requireSdk } from "./app-contract-support.mjs";

export const LIMITS = Object.freeze({ index: 4 * 1024 ** 2, archive: 256 * 1024 ** 2,
  expanded: 1024 ** 3, files: 20000, installed: 2 * 1024 ** 3 });
const kinds = ["manifest", "release", "index", "trust"];
const Ajv2020 = requireSdk("ajv/dist/2020.js").default;
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kind of kinds) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(repo, "docs/schemas", "app-" + kind + "-v1.json"), "utf8")));
export function validateShape(kind, value) {
  const validator = ajv.getSchema("https://agent-vitals.local/schemas/app-" + kind + "-v1.json");
  if (!validator || !validator(value)) throw new Error("invalid app " + kind + " structure");
}

// String-preserving parser: duplicate names are rejected before JSON.parse loses them.
export function parseSignedJson(bytes, limit = LIMITS.index) {
  if (Buffer.byteLength(bytes) > limit) throw new Error("JSON budget exceeded");
  const input = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(input[at] ?? "") && at < input.length) at++; };
  function string() {
    const start = at++;
    while (at < input.length) {
      const ch = input[at++];
      if (ch === "\\") { at++; continue; }
      if (ch === '"') return JSON.parse(input.slice(start, at));
    }
    throw new Error("unterminated JSON string");
  }
  function value(depth = 0) {
    if (depth > 64) throw new Error("JSON depth exceeded");
    ws();
    if (input[at] === '"') return string();
    if (input[at] === "{") {
      at++; ws();
      const result = Object.create(null), names = new Set();
      if (input[at] === "}") { at++; return result; }
      while (at < input.length) {
        ws(); if (input[at] !== '"') throw new Error("invalid JSON member");
        const key = string();
        if (names.has(key)) throw new Error("duplicate JSON key");
        names.add(key); ws();
        if (input[at++] !== ":") throw new Error("invalid JSON member");
        result[key] = value(depth + 1); ws();
        const end = input[at++];
        if (end === "}") return result;
        if (end !== ",") throw new Error("invalid JSON object");
      }
    } else if (input[at] === "[") {
      at++; ws(); const result = [];
      if (input[at] === "]") { at++; return result; }
      while (at < input.length) {
        result.push(value(depth + 1)); ws();
        const end = input[at++];
        if (end === "]") return result;
        if (end !== ",") throw new Error("invalid JSON array");
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(input.slice(at));
      if (match) {
        if (/^[0-9-]/.test(match[0]) && /[.eE]/.test(match[0])) throw new Error("non-integer JSON number token");
        at += match[0].length; return JSON.parse(match[0]);
      }
    }
    throw new Error("invalid JSON value");
  }
  const result = value(); ws();
  if (at !== input.length) throw new Error("trailing JSON input");
  canonical(result); // I-JSON plus the declared integer-only profile.
  return result;
}

export function canonical(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("unsafe canonical number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("invalid Unicode surrogate");
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid Unicode surrogate");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    return "{" + Object.keys(value).sort().map((key) => canonical(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  throw new Error("unsupported canonical value");
}
export const digest = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function signatureMessage(kind, envelope) {
  if (!["index", "release", "trust"].includes(kind)) throw new Error("invalid signature domain");
  return Buffer.from("agent-vitals/app-" + kind + "/v1\0" + canonical({
    algorithm: envelope.signature.algorithm, key_id: envelope.signature.key_id, payload: envelope.payload }), "utf8");
}
function verifySignature(kind, envelope, publicKey) {
  const signature = Buffer.from(envelope.signature.value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== envelope.signature.value
    || !verify(null, signatureMessage(kind, envelope), publicKey, signature)) throw new Error("invalid app signature");
}
function trustedKey(policy, envelope, purpose, sequence) {
  const key = policy.keys.find((candidate) => candidate.key_id === envelope.signature.key_id);
  if (!key || key.revoked || !key.purposes.includes(purpose) || sequence < key.valid_from_sequence
    || (key.valid_until_sequence !== null && sequence > key.valid_until_sequence)) throw new Error("untrusted app signing key");
  return { policy: key, publicKey: createPublicKey({ key: key.public_key, format: "jwk" }) };
}
export function verifyTrust(envelope, roots, current = null) {
  validateShape("trust", envelope);
  const root = roots.get(envelope.signature.key_id);
  if (!root) throw new Error("unknown trust root");
  verifySignature("trust", envelope, root);
  const next = envelope.payload;
  const prefix = new URL(next.download_prefix);
  if (prefix.protocol !== "https:" || prefix.username || prefix.password || prefix.search || prefix.hash
    || !prefix.pathname.endsWith("/")) throw new Error("invalid frozen download prefix");
  if (new Set(next.keys.map((key) => key.key_id)).size !== next.keys.length) throw new Error("duplicate key id");
  for (const key of next.keys) {
    if (key.purposes.length === 0 || (key.valid_until_sequence !== null && key.valid_until_sequence < key.valid_from_sequence)) throw new Error("invalid key policy");
    createPublicKey({ key: key.public_key, format: "jwk" });
  }
  if (current) {
    if (next.source_id !== current.source_id || next.download_prefix !== current.download_prefix
      || next.trust_sequence < current.trust_sequence
      || (next.trust_sequence === current.trust_sequence && digest(next) !== digest(current))) throw new Error("trust rollback or fork");
    for (const old of current.keys) {
      const key = next.keys.find((entry) => entry.key_id === old.key_id);
      if (!key || canonical(key.public_key) !== canonical(old.public_key) || key.publisher !== old.publisher || key.platform_team_id !== old.platform_team_id
        || (old.revoked && !key.revoked)) throw new Error("key removal, rebinding or unrevocation");
    }
    if (current.revoked_archive_sha256.some((hash) => !next.revoked_archive_sha256.includes(hash))) throw new Error("release unrevocation");
  }
  return structuredClone(next); // Caller persists only after complete verified transition.
}
function allowedUrl(text, policy, archiveHash) {
  const url = new URL(text);
  if (url.href !== text || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !text.startsWith(policy.download_prefix) || /%|\\/.test(text)
    || !url.pathname.endsWith("/" + archiveHash + ".zip")) throw new Error("untrusted or mutable package URL");
}
function safePath(text) {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(text)
    || text.split("/").some((part) => part === "." || part === "..")) throw new Error("unsafe resource path");
}
const versionParts = (version) => version.split(".").map(Number);
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export function verifyManifest(manifest, target = null) {
  validateShape("manifest", manifest);
  if (target && (manifest.platform !== target.platform || manifest.architecture !== target.architecture
    || manifest.platform_identity.team_id !== target.team_id)) throw new Error("platform identity mismatch");
  const compatibility = manifest.harness_compatibility;
  if (compareVersions(compatibility.min_version, compatibility.max_version_exclusive) >= 0) throw new Error("invalid harness compatibility range");
  if (target && (compareVersions(target.harness_version, compatibility.min_version) < 0
    || compareVersions(target.harness_version, compatibility.max_version_exclusive) >= 0
    || !compatibility.broker_versions.includes(target.broker_version))) throw new Error("incompatible harness");
  const files = new Map(); let expanded = 0;
  for (const file of manifest.resources) {
    safePath(file.path);
    if (!file.path.startsWith(manifest.entry + "/") || files.has(file.path.toLowerCase())) throw new Error("outside bundle or resource collision");
    files.set(file.path.toLowerCase(), file); expanded += file.size_bytes;
  }
  if (expanded > LIMITS.expanded || files.size === 0) throw new Error("expanded resource budget exceeded");
  for (const pathname of files.keys()) {
    const parts = pathname.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join("/"))) throw new Error("file/directory ancestor collision");
    }
  }
  const executable = files.get((manifest.entry + "/Contents/MacOS/agent-city").toLowerCase());
  if (!executable || executable.path !== manifest.entry + "/Contents/MacOS/agent-city"
    || executable.mode !== "executable") throw new Error("missing verified executable");
  const licenses = new Map(manifest.licenses.map((license) => [license.id, license]));
  if (licenses.size !== manifest.licenses.length) throw new Error("duplicate license");
  for (const license of licenses.values()) {
    safePath(license.notice_path);
    if (files.get(license.notice_path.toLowerCase())?.path !== license.notice_path) throw new Error("missing license notice");
  }
  for (const file of files.values()) if (!licenses.has(file.license_id)) throw new Error("unlicensed resource");
  for (const file of [manifest.display.icon_path]) {
    safePath(file); if (files.get(file.toLowerCase())?.path !== file) throw new Error("missing display asset");
  }
  const identity = (query) => query.id + "/" + query.face;
  if (new Set(manifest.requires.map(identity)).size !== manifest.requires.length
    || new Set(manifest.permissions.projections.map(identity)).size !== manifest.permissions.projections.length) throw new Error("duplicate projection capability");
  for (const query of manifest.requires) {
    if (query.versions.length === 0) throw new Error("empty projection versions");
    const permission = manifest.permissions.projections.find((entry) => identity(entry) === identity(query));
    if (query.required && (!permission || query.versions.some((version) => !permission.versions.includes(version)))) throw new Error("required projection permission missing");
  }
  for (const permission of manifest.permissions.projections) {
    if (permission.versions.length === 0 || !manifest.requires.some((entry) => identity(entry) === identity(permission)
      && permission.versions.every((version) => entry.versions.includes(version)))) throw new Error("undeclared projection permission");
  }
  return expanded;
}
export function verifyRelease(envelope, policy, target = null) {
  validateShape("release", envelope);
  const release = envelope.payload;
  if (release.source_id !== policy.source_id) throw new Error("wrong release source");
  const key = trustedKey(policy, envelope, "release", release.release_sequence);
  verifySignature("release", envelope, key.publicKey);
  if (release.manifest.signing_key_id !== envelope.signature.key_id || release.manifest.publisher !== key.policy.publisher
    || release.manifest.platform_identity.team_id !== key.policy.platform_team_id
    || release.manifest_sha256 !== digest(release.manifest)) throw new Error("manifest identity/digest mismatch");
  if (policy.revoked_archive_sha256.includes(release.archive.sha256)) throw new Error("revoked release");
  allowedUrl(release.archive.url, policy, release.archive.sha256);
  verifyManifest(release.manifest, target);
  return release;
}
export function verifyIndex(envelope, policy, highWater, nowMs) {
  validateShape("index", envelope);
  if (Buffer.byteLength(canonical(envelope)) > LIMITS.index) throw new Error("index budget exceeded");
  const index = envelope.payload;
  if (index.source_id !== policy.source_id || index.trust_sequence !== policy.trust_sequence) throw new Error("index trust/source mismatch");
  const key = trustedKey(policy, envelope, "index", index.catalog_sequence);
  verifySignature("index", envelope, key.publicKey);
  if (!Number.isSafeInteger(nowMs) || index.published_at_ms > nowMs || index.expires_at_ms <= nowMs
    || index.expires_at_ms <= index.published_at_ms) throw new Error("expired or future index");
  const ids = new Set();
  for (const entry of index.entries) {
    const release = verifyRelease(entry, policy);
    const id = [release.manifest.id, release.manifest.version, release.manifest.platform, release.manifest.architecture].join("/");
    if (ids.has(id)) throw new Error("duplicate app release");
    ids.add(id);
  }
  const next = { source_id: index.source_id, sequence: index.catalog_sequence, digest: digest(index) };
  if (highWater && (highWater.source_id !== next.source_id || next.sequence < highWater.sequence
    || (next.sequence === highWater.sequence && next.digest !== highWater.digest))) throw new Error("catalog replay or fork");
  return next; // Pure result. Never mutate the caller's watermark on failure.
}
export function verifyFileRecords(manifest, records) {
  verifyManifest(manifest);
  if (records.length !== manifest.resources.length || records.length > LIMITS.files) throw new Error("file inventory mismatch");
  const declared = new Map(manifest.resources.map((file) => [file.path, file]));
  for (const file of records) {
    safePath(file.path);
    const expected = declared.get(file.path);
    if (!expected || file.type !== "regular" || file.size_bytes !== expected.size_bytes
      || file.sha256 !== expected.sha256 || file.mode !== expected.mode) throw new Error("unverified file record");
    declared.delete(file.path);
  }
  if (declared.size !== 0) throw new Error("missing file");
  // C7 must derive these records from actual streamed bytes/lstat, not archive headers.
}

export function installationBudget({ retainedBytes, archiveBytes, expandedBytes, controlBytes, availableBytes }) {
  for (const value of [retainedBytes, archiveBytes, expandedBytes, controlBytes, availableBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid disk measurement");
  }
  if (archiveBytes > LIMITS.archive || expandedBytes > LIMITS.expanded || controlBytes > LIMITS.index) throw new Error("package budget exceeded");
  const finalBytes = retainedBytes + expandedBytes + controlBytes;
  const stagingBytes = archiveBytes + expandedBytes + controlBytes + 64 * 1024 ** 2;
  if (!Number.isSafeInteger(finalBytes) || !Number.isSafeInteger(stagingBytes)
    || finalBytes > LIMITS.installed || availableBytes < stagingBytes) throw new Error("installation disk budget exceeded");
  return { finalBytes, stagingBytes };
}
