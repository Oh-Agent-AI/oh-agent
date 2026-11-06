#!/usr/bin/env node
// Exercise the production task client with deterministic worker/clock adapters.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/export/filmJob.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", logLevel: "silent" }).outputFiles[0].text;
let now = 0;
let timerId = 0;
const timers = new Map();
class TestWorker {
  terminated = 0; posts = [];
  postMessage(message) { this.posts.push(message); }
  terminate() { this.terminated++; }
  emit(message) { this.onmessage?.({ data: message }); }
}
const module = { exports: {} };
class TestBitmap { closed = 0; close() { this.closed++; } }
const environment = { module, exports: module.exports, Worker: TestWorker, OffscreenCanvas: class {},
  VideoEncoder: class {}, VideoFrame: class {}, ImageBitmap: TestBitmap, Blob, Error, DOMException, URL,
  performance: { now: () => now }, setInterval: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
  clearInterval: (id) => timers.delete(id) };
vm.runInNewContext(code, environment);
const { runFilmJob, supportsBackgroundFilm } = module.exports;
const job = { model: {}, seed: 42, cut: "short", locale: "en", width: 320, height: 180, fps: 1, bitrate: 120000 };
function start(onPreview) {
  const worker = new TestWorker(); const controller = new AbortController(); const progress = [];
  const promise = runFilmJob(job, { signal: controller.signal, workerFactory: () => worker,
    onProgress: (frame, total) => progress.push([frame, total]), onPreview });
  return { worker, controller, promise, progress };
}
function advance(ms) { now += ms; for (const timer of [...timers.values()]) timer(); }
let task = start();
task.worker.emit({ type: "ready" });
task.worker.emit({ type: "ready" });
assert.equal(task.worker.posts.length, 1, "start is acknowledged only once");
assert.equal(task.worker.posts[0].job.locale, "en", "export captures the plugin language in the Worker job");
task.worker.emit({ type: "progress", frame: 1, total: 5 });
task.worker.emit({ type: "progress", frame: 6, total: 5 });
assert.deepEqual(task.progress, [[1, 5]]);
const blob = new Blob(["synthetic mp4"], { type: "video/mp4" });
task.worker.emit({ type: "complete", blob });
assert.equal(await task.promise, blob);
assert.equal(task.worker.terminated, 1);
task.worker.emit({ type: "error", code: "late_failure" });
assert.equal(task.worker.terminated, 1);
let seenPreview = 0;
task = start((bitmap, frame) => { assert.equal(bitmap.closed, 0); assert.equal(frame, 3); seenPreview++; });
const bitmap = new TestBitmap();
task.worker.emit({ type: "preview", bitmap, frame: 3 });
assert.equal(seenPreview, 1); assert.equal(bitmap.closed, 1);
assert.equal(task.worker.posts.at(-1).type, "preview-ack");
task.controller.abort(); await assert.rejects(task.promise, { name: "AbortError" });
const lateBitmap = new TestBitmap(), posts = task.worker.posts.length;
task.worker.emit({ type: "preview", bitmap: lateBitmap, frame: 4 });
assert.equal(lateBitmap.closed, 1); assert.equal(task.worker.posts.length, posts);
task = start(() => { throw new Error("preview failure"); });
const failedBitmap = new TestBitmap();
task.worker.emit({ type: "preview", bitmap: failedBitmap, frame: 3 });
await assert.rejects(task.promise, /background_export_failed/); assert.equal(failedBitmap.closed, 1);
task = start();
const ignoredBitmap = new TestBitmap();
task.worker.emit({ type: "preview", bitmap: ignoredBitmap, frame: 0 });
assert.equal(ignoredBitmap.closed, 1);
task.controller.abort(); await assert.rejects(task.promise, { name: "AbortError" });
task = start();
task.worker.postMessage = () => { throw new Error("ack failed"); };
const ackBitmap = new TestBitmap();
task.worker.emit({ type: "preview", bitmap: ackBitmap, frame: 0 });
await assert.rejects(task.promise, /background_export_failed/); assert.equal(ackBitmap.closed, 1);
task = start(); task.worker.emit({ type: "ready" });
task.controller.abort();
await assert.rejects(task.promise, { name: "AbortError" });
assert.equal(task.worker.terminated, 1, "cancellation must terminate, not wait for worker cooperation");
task = start(); advance(16000);
await assert.rejects(task.promise, /background_export_timeout/);
task = start(); task.worker.emit({ type: "ready" }); advance(29000);
task.worker.emit({ type: "pulse" }); advance(29000);
assert.equal(task.worker.terminated, 0);
advance(2000); await assert.rejects(task.promise, /background_export_timeout/);
task = start(); task.worker.emit({ type: "ready" });
task.worker.emit({ type: "error", code: "export_memory_limit" });
await assert.rejects(task.promise, /export_memory_limit/);
task = start(); task.worker.emit(null);
await assert.rejects(task.promise, /background_export_failed/);
// F5（CITY_DATA_LEGIBILITY_SPEC）：无 H.264 的环境明确导出 WebM——video/webm 是合法成片；其它容器仍拒收。
const webm = new Blob(["synthetic webm"], { type: "video/webm" });
task = start(); task.worker.emit({ type: "complete", blob: webm });
assert.equal(await task.promise, webm);
task = start(); task.worker.emit({ type: "complete", blob: new Blob(["wrong container"], { type: "video/quicktime" }) });
await assert.rejects(task.promise, /background_export_failed/);
task = start(); task.worker.emit({ type: "error", code: "video_encoder_unavailable" });
await assert.rejects(task.promise, /video_encoder_unavailable/);
task = start(); task.worker.onerror({ preventDefault() {} });
await assert.rejects(task.promise, /background_export_failed/);
const aborted = new AbortController(); aborted.abort();
let created = false;
await assert.rejects(runFilmJob(job, { signal: aborted.signal, onProgress() {}, workerFactory() { created = true; return new TestWorker(); } }), { name: "AbortError" });
assert.equal(created, false);
environment.OffscreenCanvas = undefined;
assert.equal(supportsBackgroundFilm(), false);
await assert.rejects(runFilmJob(job, { signal: new AbortController().signal, onProgress() {} }), /background_export_unavailable/);
assert.equal(timers.size, 0, "every outcome must clean up its timer");
console.log("City film jobs: passed (ready/start, progress, preview acknowledgement/bitmap release/late frames/callback and transport errors, completion, immediate cancel, boot/hang deadlines, worker errors, memory-limit propagation, unsupported capability and cleanup).");

const muxerCode = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/engine/mp4Muxer.ts", import.meta.url).pathname],
  bundle: true, external: ["mp4-muxer"], write: false, format: "cjs" }).outputFiles[0].text;
const writes = []; let writeFailure = false;
class TestMuxer {
  constructor(options) { this.options = options; assert.equal(options.video.codec, "avc");
    assert.equal(options.video.frameRate, 30); assert.equal(options.video.width, 320); assert.equal(options.video.height, 180);
    assert.equal(options.fastStart, "in-memory"); assert.equal(options.firstTimestampBehavior, "strict"); }
  addVideoChunk(packet, metadata) { if (writeFailure) throw new Error("muxer failure"); writes.push([packet, metadata]); }
  finalize() { this.options.target.buffer = new Uint8Array([1, 2, 3]).buffer; }
}
const muxerModule = { exports: {} };
vm.runInNewContext(muxerCode, { module: muxerModule, exports: muxerModule.exports, Blob, DOMException,
  require: () => ({ ArrayBufferTarget: class {}, Muxer: TestMuxer }) });
let writer = new muxerModule.exports.Mp4Writer(30, 320, 180); await writer.start();
const metadata = { decoderConfig: { codec: "avc1.640028", description: new Uint8Array([1]) } };
writer.addChunk({ timestamp: 0 }, metadata); writer.addChunk({ timestamp: 33333 });
const mp4 = await writer.finish(); assert.equal(mp4.type, "video/mp4"); assert.equal(mp4.size, 3);
assert.equal(writes.length, 2); assert.equal(writes[0][1], metadata); assert.equal(writes[1][0].timestamp, 33333);
writeFailure = true; writer = new muxerModule.exports.Mp4Writer(30, 320, 180); await writer.start(); writer.addChunk({ timestamp: 0 }, metadata);
await assert.rejects(writer.drain(), /muxer failure/); await writer.cancel();
writeFailure = false; writer = new muxerModule.exports.Mp4Writer(30, 320, 180); await writer.start(); await writer.cancel();
await assert.rejects(writer.drain(), { name: "AbortError" });
console.log("City MP4 muxer: passed (AVC track, metadata, ordered writes, draining, MP4 MIME, error and cancel cleanup).");

// F5（CITY_DATA_LEGIBILITY_SPEC）：WebM 回退封装与 Mp4Writer 同接口，产出真正的 WebM（EBML 头 + video/webm）。
const webmCode = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/engine/webmMuxer.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs" }).outputFiles[0].text;
const webmModule = { exports: {} };
vm.runInNewContext(webmCode, { module: webmModule, exports: webmModule.exports, Blob, DOMException, Uint8Array, DataView, ArrayBuffer, TextEncoder, Math, Number });
const chunk = (timestamp, type) => ({ timestamp, type, byteLength: 4, copyTo(target) { target.set([1, 2, 3, 4]); } });
let webmWriter = new webmModule.exports.WebmFilmWriter("V_VP9", 30, 320, 180); await webmWriter.start();
webmWriter.addChunk(chunk(0, "key")); webmWriter.addChunk(chunk(33333, "delta"));
const webmBlob = await webmWriter.finish();
assert.equal(webmBlob.type, "video/webm");
const head = new Uint8Array(await webmBlob.arrayBuffer()).slice(0, 4);
assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3], "WebM starts with the EBML magic, not a renamed MP4");
webmWriter = new webmModule.exports.WebmFilmWriter("V_VP8", 30, 320, 180); await webmWriter.start(); await webmWriter.cancel();
await assert.rejects(webmWriter.drain(), { name: "AbortError" });
console.log("City WebM fallback writer: passed (Mp4Writer-compatible interface, EBML header, video/webm MIME, cancel).");
