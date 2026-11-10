/**
 * Dream snapshot wire encoding. This is not a data projection or authorization
 * boundary: the trusted City host must validate the original snapshot before
 * passing its bytes here, and validate the decoded contract before using it.
 */
export const DREAM_SNAPSHOT_MAX_PLAIN_BYTES = 4 * 1024 * 1024;
export const DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES = 230 * 1024;
const MAX_COMPRESSED_BYTES = Math.floor(DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES * 3 / 4);

export type DreamSnapshotEnvelopeV1 = {
  schema: "dream-city-gzip:v1";
  plainBytes: number;
  data: string;
};

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, errorCode = "dream_snapshot_too_large", measureOverflow = false): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit && !measureOverflow) {
        await reader.cancel().catch(() => {});
        throw new Error(errorCode);
      }
      if (length > limit) exceeded = true;
      if (!exceeded) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (exceeded) throw new Error(`${errorCode}_${length}`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("dream_snapshot_invalid");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("dream_snapshot_invalid"); }
  if (binary.length > MAX_COMPRESSED_BYTES || btoa(binary) !== value) throw new Error("dream_snapshot_invalid");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function encodeDreamSnapshot(plain: Uint8Array): Promise<DreamSnapshotEnvelopeV1> {
  if (!plain.byteLength || plain.byteLength > DREAM_SNAPSHOT_MAX_PLAIN_BYTES) throw new Error("dream_snapshot_plain_too_large");
  if (typeof CompressionStream === "undefined") throw new Error("dream_compression_unavailable");
  const compressed = await readBounded(new Blob([plain.slice().buffer]).stream().pipeThrough(new CompressionStream("gzip")), MAX_COMPRESSED_BYTES, "dream_snapshot_compressed_too_large", true);
  const envelope: DreamSnapshotEnvelopeV1 = { schema: "dream-city-gzip:v1", plainBytes: plain.byteLength, data: toBase64(compressed) };
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES) throw new Error("dream_snapshot_envelope_too_large");
  return envelope;
}

export async function decodeDreamSnapshot(value: unknown): Promise<Uint8Array> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dream_snapshot_invalid");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || object.schema !== "dream-city-gzip:v1" || typeof object.data !== "string"
      || !Number.isSafeInteger(object.plainBytes) || (object.plainBytes as number) < 1 || (object.plainBytes as number) > DREAM_SNAPSHOT_MAX_PLAIN_BYTES
      || object.data.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4
      || new TextEncoder().encode(JSON.stringify(value)).byteLength > DREAM_SNAPSHOT_MAX_ENVELOPE_BYTES) throw new Error("dream_snapshot_invalid");
  if (typeof DecompressionStream === "undefined") throw new Error("dream_compression_unavailable");
  const bytes = fromBase64(object.data);
  let plain: Uint8Array;
  try {
    plain = await readBounded(new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("gzip")), object.plainBytes as number);
  } catch { throw new Error("dream_snapshot_invalid"); }
  if (plain.byteLength !== object.plainBytes) throw new Error("dream_snapshot_invalid");
  return plain;
}
