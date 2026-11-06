import type { CompiledCitySurface } from "./types";
import { sha256SurfaceBytes } from "./surfaceDigest";

export type SurfaceHasher = (bytes: Uint8Array) => Promise<string>;
export type SurfacePublication = Readonly<{ status: "published"; revision: string; bufferBytes: number; encodedBytes: number }> | Readonly<{ status: "stale" }>;
/** Only one owned snapshot; reads are defensive copies, never writable aliases.
 * Hashing is injectable for Node/headless use, with no Node/DOM/render dependency. */
export class SurfaceStore {
  private current: CompiledCitySurface | null = null;
  private generation = 0;
  constructor(private readonly hash: SurfaceHasher = sha256SurfaceBytes, private readonly maxBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid-surface-store-budget");
  }
  get revision(): string | null { return this.current?.revision ?? null; }
  clear(): void { this.generation++; this.current = null; }
  async publish(input: CompiledCitySurface): Promise<SurfacePublication> {
    const generation = ++this.generation;
    const bytes = snapshotBufferBytes(input);
    if (bytes > this.maxBytes) throw new Error("surface-store-budget");
    validateSurfaceSnapshot(input);
    // Capture before awaiting: source edits cannot alter bytes under a recorded hash.
    const owned = cloneSnapshot(input);
    const canonical = canonicalSurfaceBytes(owned, this.maxBytes);
    if (canonical.byteLength > this.maxBytes) throw new Error("surface-store-budget");
    const digest = await this.hash(canonical);
    if (generation !== this.generation) return Object.freeze({ status: "stale" });
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid-surface-digest");
    const revision = `surface-v${owned.geometryVersion}:sha256:${digest}`;
    this.current = Object.freeze({ ...owned, revision });
    return Object.freeze({ status: "published", revision, bufferBytes: bytes, encodedBytes: canonical.byteLength });
  }
  /** Read by expected revision so a caller cannot accidentally acquire newer data. */
  read(expectedRevision: string): CompiledCitySurface | null {
    if (!this.current || this.current.revision !== expectedRevision) return null;
    return cloneSnapshot(this.current);
  }
}

export function snapshotBufferBytes(snapshot: CompiledCitySurface): number {
  return snapshot.patches.reduce((n, patch) => n + patch.vertices.byteLength + patch.indices.byteLength, 0) +
    snapshot.renderBatches.reduce((n, batch) => n + batch.positions.byteLength + batch.indices.byteLength, 0);
}
function cloneSnapshot(input: CompiledCitySurface): CompiledCitySurface {
  return Object.freeze({ revision: input.revision, geometryVersion: input.geometryVersion,
    patches: Object.freeze(input.patches.map((patch) => Object.freeze({ ...patch, source: Object.freeze({ ...patch.source }),
      vertices: patch.vertices.slice(), indices: patch.indices.slice(),
      boundaryLoops: Object.freeze(patch.boundaryLoops.map((loop) => Object.freeze({ hole: loop.hole,
        vertices: Object.freeze(loop.vertices.map((p) => Object.freeze({ ...p }))), segments: Object.freeze([...loop.segments]) }))) }))),
    portals: Object.freeze(input.portals.map((portal) => Object.freeze({ ...portal,
      fromBoundary: Object.freeze({ ...portal.fromBoundary }), toBoundary: Object.freeze({ ...portal.toBoundary }) }))),
    renderBatches: Object.freeze(input.renderBatches.map((batch) => Object.freeze({ ...batch,
      patchIds: Object.freeze([...batch.patchIds]), positions: batch.positions.slice(), indices: batch.indices.slice() }))),
    report: Object.freeze({ ...input.report, issues: Object.freeze(input.report.issues.map((issue) => Object.freeze({ ...issue, source: Object.freeze({ ...issue.source }) }))) }) });
}
function validateSurfaceSnapshot(input: CompiledCitySurface): void {
  if (!Number.isSafeInteger(input.geometryVersion) || input.geometryVersion < 1) throw new Error("invalid-surface-version");
  const ids = new Set<string>();
  const mesh = (positions: Float32Array, indices: Uint32Array) => {
    if (!(positions instanceof Float32Array) || !(indices instanceof Uint32Array) || positions.length % 3 || indices.length % 3) throw new Error("invalid-surface-buffer");
    for (const n of positions) if (!Number.isFinite(n)) throw new Error("invalid-surface-buffer");
    for (const i of indices) if (i >= positions.length / 3) throw new Error("invalid-surface-index");
  };
  for (const patch of input.patches) {
    if (!patch.id.trim() || ids.has(patch.id) || !patch.layerId.trim() || !patch.source.id.trim()) throw new Error("invalid-surface-identity");
    ids.add(patch.id); mesh(patch.vertices, patch.indices);
    for (const loop of patch.boundaryLoops) {
      if (loop.vertices.length < 3 || loop.vertices.length !== loop.segments.length || loop.vertices.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) throw new Error("invalid-surface-boundary");
    }
  }
  const patches = new Map(input.patches.map((patch) => [patch.id, patch])); const portals = new Set<string>();
  for (const portal of input.portals) {
    if (!portal.id.trim() || portals.has(portal.id) || portal.fromPatch === portal.toPatch || !patches.has(portal.fromPatch) || !patches.has(portal.toPatch) || !Number.isFinite(portal.clearance) || portal.clearance <= 0 || !Number.isFinite(portal.maxHeightMismatch) || portal.maxHeightMismatch < 0) throw new Error("invalid-surface-portal");
    portals.add(portal.id);
    for (const [id, span] of [[portal.fromPatch, portal.fromBoundary], [portal.toPatch, portal.toBoundary]] as const) {
      const loops = patches.get(id)!.boundaryLoops;
      if (!Number.isSafeInteger(span.loop) || span.loop < 0 || !loops[span.loop] || !Number.isSafeInteger(span.firstSegment) || span.firstSegment < 0 || !Number.isSafeInteger(span.segmentCount) || span.segmentCount < 1 || span.firstSegment + span.segmentCount > loops[span.loop].segments.length) throw new Error("invalid-portal-span");
    }
  }
  for (const batch of input.renderBatches) {
    mesh(batch.positions, batch.indices);
    if (batch.patchIds.some((id) => !ids.has(id))) throw new Error("unknown-render-patch");
  }
  if (![input.report.candidateLength, input.report.geometricallyEligibleLength].every((n) => Number.isFinite(n) && n >= 0) || input.report.geometricallyEligibleLength > input.report.candidateLength) throw new Error("invalid-surface-report");
}

/** Canonical binary framing, explicit little endian. Does not include presentation
 * material names or a caller-provided revision. Geometry/topology/source changes do. */
export function canonicalSurfaceBytes(input: CompiledCitySurface, maxBytes = 32 * 1024 * 1024): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid-surface-store-budget");
  const chunks: Uint8Array[] = []; let total = 0;
  const bytes = (value: Uint8Array) => {
    const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, value.byteLength, true);
    if (total + 4 + value.byteLength > maxBytes) throw new Error("surface-store-budget");
    chunks.push(length, value); total += 4 + value.byteLength;
  };
  const text = (value: unknown) => bytes(new TextEncoder().encode(JSON.stringify(value)));
  const array = (values: Float32Array | Uint32Array) => {
    const encoded = new Uint8Array(values.length * 4); const view = new DataView(encoded.buffer);
    for (let i = 0; i < values.length; i++) {
      if (values instanceof Float32Array) view.setFloat32(i * 4, values[i], true); else view.setUint32(i * 4, values[i], true);
    }
    bytes(encoded);
  };
  text(["city-surface-content", 1, input.geometryVersion]);
  const patches = [...input.patches].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  text(patches.length);
  for (const patch of patches) {
    text([patch.id, patch.kind, patch.layerId, patch.source.kind, patch.source.id,
      patch.boundaryLoops.map((loop) => [loop.hole, loop.vertices.map((p) => [p.x, p.z]), loop.segments])]);
    array(patch.vertices); array(patch.indices);
  }
  const portals = [...input.portals].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  text(portals.length);
  for (const p of portals) text([p.id, p.fromPatch, p.toPatch, p.fromBoundary.loop, p.fromBoundary.firstSegment, p.fromBoundary.segmentCount,
    p.toBoundary.loop, p.toBoundary.firstSegment, p.toBoundary.segmentCount, p.permittedDirection, p.clearance, p.maxHeightMismatch, p.validated]);
  text(input.renderBatches.length);
  for (const batch of input.renderBatches) { text(batch.patchIds); array(batch.positions); array(batch.indices); }
  text([input.report.candidateLength, input.report.geometricallyEligibleLength,
    input.report.issues.map((issue) => [issue.source.kind, issue.source.id, issue.reason, issue.detail ?? null]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)]);
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
