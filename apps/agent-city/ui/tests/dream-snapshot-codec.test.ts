import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { decodeDreamSnapshot, encodeDreamSnapshot, DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES, DREAM_SNAPSHOT_MAX_PLAIN_BYTES } from "../src/remote/city/dreamSnapshotCodec.ts";

test("gzip snapshot envelope roundtrips Unicode and preserves original bytes", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ city: "梦境 🌆", roads: Array.from({ length: 20_000 }, (_, i) => ({ id: i, x: i % 53 })) }));
  const envelope = await encodeDreamSnapshot(bytes);
  assert.ok(new TextEncoder().encode(JSON.stringify(envelope)).length <= DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES);
  assert.deepEqual(await decodeDreamSnapshot(JSON.parse(JSON.stringify(envelope))), bytes);
});

test("rejects oversized plain data and incompressible messages", async () => {
  await assert.rejects(encodeDreamSnapshot(new Uint8Array(DREAM_SNAPSHOT_MAX_PLAIN_BYTES + 1)), /dream_snapshot_plain_too_large/);
  await assert.rejects(encodeDreamSnapshot(randomBytes(DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES)), /dream_snapshot_compressed_too_large/);
});

test("rejects corrupted, noncanonical, extended or incorrectly declared envelopes", async () => {
  const envelope = await encodeDreamSnapshot(new TextEncoder().encode("城市快照"));
  for (const altered of [
    { ...envelope, schema: "dream-city-gzip:v2" },
    { ...envelope, extra: "untrusted" },
    { ...envelope, data: "@@@=" },
    { ...envelope, data: Buffer.from("not gzip").toString("base64") },
    { ...envelope, plainBytes: envelope.plainBytes + 1 },
    { ...envelope, plainBytes: envelope.plainBytes - 1 },
  ]) await assert.rejects(decodeDreamSnapshot(altered), /dream_snapshot_invalid/);
});

test("bounded decompression rejects expansion exceeding the declared size", async () => {
  const compressed = gzipSync(Buffer.alloc(2 * 1024 * 1024, 65));
  await assert.rejects(decodeDreamSnapshot({ schema: "dream-city-gzip:v1", plainBytes: 32, data: compressed.toString("base64") }), /dream_snapshot_invalid/);
});
