import { ArrayBufferTarget, Muxer } from "mp4-muxer";

/** Video-only H.264 MP4. Runs inside the disposable export Worker, never the host. */
export class Mp4Writer {
  private readonly target = new ArrayBufferTarget();
  private readonly muxer: Muxer<ArrayBufferTarget>;
  private failure: unknown = null;

  constructor(fps: number, width: number, height: number) {
    this.muxer = new Muxer({ target: this.target, video: { codec: "avc", width, height, frameRate: fps },
      fastStart: "in-memory", firstTimestampBehavior: "strict" });
  }
  async start() { /* Track is configured synchronously; encoder starts afterward. */ }

  addChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
    // Surface callback failures to the rendering loop, rather than throwing
    // outside its Promise and leaving a stuck export task.
    if (!this.failure) { try { this.muxer.addVideoChunk(chunk, metadata); } catch (error) { this.failure = error; } }
  }
  async drain() { if (this.failure) throw this.failure; }
  async finish(): Promise<Blob> {
    await this.drain(); this.muxer.finalize();
    if (!this.target.buffer?.byteLength) throw new Error("background_export_failed");
    return new Blob([this.target.buffer], { type: "video/mp4" });
  }
  async cancel() { this.failure ??= new DOMException("aborted", "AbortError"); }
}
