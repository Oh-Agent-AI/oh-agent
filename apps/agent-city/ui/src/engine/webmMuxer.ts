/**
 * 最小 WebM（Matroska 子集）封装器：一条视频轨（VP8/VP9），整段在内存里组装后一次写出。
 *
 * 为什么自己写：MediaRecorder 按「调用 requestFrame 的墙钟时间」打时间戳，导出是逐帧渲染（每帧可能
 * 远慢于 1/fps），录出来的视频速度就不对；WebCodecs 编码器输出的 chunk 带显式时间戳，只缺一个容器。
 * 范围刻意很小：无音频、无 Cues（不支持快速拖动定位，但所有播放器都能顺序播放）、每个关键帧开一个 Cluster。
 */

export type WebmCodec = "V_VP8" | "V_VP9";

type Frame = { timestampMs: number; keyFrame: boolean; data: Uint8Array };

// ── EBML 基础编码 ──
const idBytes = (id: number): number[] => {
  const bytes: number[] = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (id >>> shift) & 0xff;
    if (byte !== 0 || bytes.length > 0) bytes.push(byte);
  }
  return bytes;
};

/** 数据大小（vint）。统一用 8 字节形式，省去按长度选编码的分支。 */
const sizeBytes = (size: number): number[] => {
  const out = [0x01, 0, 0, 0, 0, 0, 0, 0];
  let rest = size;
  for (let i = 7; i >= 1; i -= 1) { out[i] = rest % 256; rest = Math.floor(rest / 256); }
  return out;
};

const concat = (parts: Array<Uint8Array | number[]>): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

const element = (id: number, payload: Uint8Array | number[]): Uint8Array => concat([idBytes(id), sizeBytes(payload.length), payload]);

const uintPayload = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do { bytes.unshift(rest % 256); rest = Math.floor(rest / 256); } while (rest > 0);
  return bytes;
};
const uintElement = (id: number, value: number) => element(id, uintPayload(value));
const stringElement = (id: number, text: string) => element(id, Array.from(new TextEncoder().encode(text)));
const floatElement = (id: number, value: number) => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return element(id, new Uint8Array(buffer));
};

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, FlagLacing: 0x9c,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
};

export class WebmWriter {
  private readonly frames: Frame[] = [];
  constructor(private readonly options: { codec: WebmCodec; width: number; height: number }) {}

  addChunk(timestampMs: number, keyFrame: boolean, data: Uint8Array): void {
    this.frames.push({ timestampMs: Math.round(timestampMs), keyFrame, data });
  }

  /** 组装整段文件。frames 需按时间戳升序（编码器无 B 帧时天然满足）。 */
  finish(durationMs: number): Blob {
    const ebml = element(ID.EBML, concat([
      uintElement(ID.EBMLVersion, 1), uintElement(ID.EBMLReadVersion, 1), uintElement(ID.EBMLMaxIDLength, 4), uintElement(ID.EBMLMaxSizeLength, 8),
      stringElement(ID.DocType, "webm"), uintElement(ID.DocTypeVersion, 4), uintElement(ID.DocTypeReadVersion, 2),
    ]));
    const info = element(ID.Info, concat([
      uintElement(ID.TimecodeScale, 1_000_000), floatElement(ID.Duration, durationMs),
      stringElement(ID.MuxingApp, "agent-vitals"), stringElement(ID.WritingApp, "agent-vitals"),
    ]));
    const tracks = element(ID.Tracks, element(ID.TrackEntry, concat([
      uintElement(ID.TrackNumber, 1), uintElement(ID.TrackUID, 1), uintElement(ID.TrackType, 1), uintElement(ID.FlagLacing, 0),
      stringElement(ID.CodecID, this.options.codec),
      element(ID.Video, concat([uintElement(ID.PixelWidth, this.options.width), uintElement(ID.PixelHeight, this.options.height)])),
    ])));

    // Cluster：每个关键帧开一个新 Cluster；块内时间码是相对 Cluster 的 int16（毫秒），
    // 关键帧间隔 2 秒时远小于 32767 上限。
    const clusters: Uint8Array[] = [];
    let current: { start: number; blocks: Uint8Array[] } | null = null;
    const flush = () => {
      if (!current) return;
      clusters.push(element(ID.Cluster, concat([uintElement(ID.Timecode, current.start), ...current.blocks])));
      current = null;
    };
    for (const frame of this.frames) {
      if (!current || frame.keyFrame || frame.timestampMs - current.start > 30_000) { flush(); current = { start: frame.timestampMs, blocks: [] }; }
      const relative = frame.timestampMs - current.start;
      const header = [0x81, (relative >> 8) & 0xff, relative & 0xff, frame.keyFrame ? 0x80 : 0x00];
      current.blocks.push(element(ID.SimpleBlock, concat([header, frame.data])));
    }
    flush();

    const body = concat([info, tracks, ...clusters]);
    const segment = element(ID.Segment, body);
    return new Blob([ebml as BlobPart, segment as BlobPart], { type: "video/webm" });
  }
}

/** 与 Mp4Writer 同接口的 WebM 封装（CITY_DATA_LEGIBILITY_SPEC F5）：环境没有 H.264 编码器时用 VP9/VP8 导出。
 *  明确是 WebM（文件名 .webm、MIME video/webm、界面写明），不是把 WebM 改名成 MP4。 */
export class WebmFilmWriter {
  private readonly writer: WebmWriter;
  private lastTimestampMs = 0;
  private failure: unknown = null;
  constructor(private readonly codec: WebmCodec, private readonly fps: number, width: number, height: number) {
    this.writer = new WebmWriter({ codec, width, height });
  }
  async start() { /* 同 Mp4Writer：轨道在构造时已确定。 */ }
  addChunk(chunk: EncodedVideoChunk, _metadata?: EncodedVideoChunkMetadata) {
    if (this.failure) return;
    try {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const timestampMs = chunk.timestamp / 1000;
      this.lastTimestampMs = Math.max(this.lastTimestampMs, timestampMs);
      this.writer.addChunk(timestampMs, chunk.type === "key", data);
    } catch (error) { this.failure = error; }
  }
  async drain() { if (this.failure) throw this.failure; }
  async finish(): Promise<Blob> {
    await this.drain();
    const blob = this.writer.finish(this.lastTimestampMs + 1000 / this.fps);
    if (!blob.size) throw new Error("background_export_failed");
    return blob.type === "video/webm" ? blob : new Blob([blob], { type: "video/webm" });
  }
  async cancel() { this.failure ??= new DOMException("aborted", "AbortError"); }
}
