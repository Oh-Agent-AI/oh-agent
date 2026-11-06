/**
 * DrivingSfx：驾车音效——Web Audio 程序化合成，零音频资产，模式对齐飞行版
 * GameSfx。引擎声 = 锯齿（发动机粗糙感）+ 正弦副低频（sub-bass 体感），音高/
 * 音量随 |speed|/maxSpeed 连续映射；怠速地板 42Hz 保证零速不静音（Three.js-
 * City 的做法在 speed=0 时音频归零，是已知缺陷，此处显式规避）。LFO ±2Hz/8Hz
 * 制造有机怠速颤动。刹车 = 滤波白噪声短包层；倒车 = 音高整体下移 20% +
 * 800Hz 间歇蜂鸣（250ms 开/关）；碰撞 = 滤波噪声爆发 + 低频正弦闷击，
 * 150ms 衰减。AudioContext 经共享 GameAudioService 惰性获取（dispose 仅释放本通道）；AudioContext
 * 不可用（Node/测试桩）时静默降级，绝不抛错。
 */

import { gameAudioService, type GameAudioChannel, type GameAudioService } from "../audio/GameAudioService";

const MASTER_GAIN = 0.5;
/** 怠速地板（Hz）：零速时引擎仍在转，杜绝 speed=0 静音缺陷。 */
const IDLE_FLOOR = 42;
/** 满速音高（Hz）。 */
const MAX_PITCH = 180;
/** 怠速音量（0-1）：安静但不缺席。 */
const IDLE_VOLUME = 0.06;
/** 满速音量（0-1）。 */
const MAX_VOLUME = 0.4;
/** 倒车时的整体音高下移系数（-20%）。 */
const REVERSE_PITCH_FACTOR = 0.8;
/** 倒车蜂鸣频率（Hz）与节奏（250ms 开 / 250ms 关）。 */
const REVERSE_BEEP_HZ = 800;
const REVERSE_BEEP_PERIOD = 0.5;
const REVERSE_BEEP_DURATION = 0.25;
/** LFO 有机颤动：8Hz、±2Hz。 */
const LFO_HZ = 8;
const LFO_DEPTH_HZ = 2;
/** 刹车噪声层有效所需的最小车速（世界单位/秒）。 */
const BRAKE_MIN_SPEED = 0.5;

// NaN 收敛到 0（怠速），±∞ 按方向收敛到边界（∞ 速 → 满挡，绝不除零/NaN 传播）。
const clamp01 = (v: number) => (Number.isNaN(v) ? 0 : v > 1 ? 1 : v < 0 ? 0 : v);

/** 纯函数：引擎音高映射 idleFloor + (maxPitch - idleFloor) * |speed| / maxSpeed。
 *  供 verify 脚本直接断言（NaN/∞ 极端值安全收敛到边界）。 */
export function engineFrequency(speed: number, maxSpeed: number): number {
  const ratio = clamp01(Math.abs(speed) / Math.max(Math.abs(maxSpeed), 1e-6));
  return IDLE_FLOOR + (MAX_PITCH - IDLE_FLOOR) * ratio;
}

/** 纯函数：引擎音量随 |speed|/maxSpeed 从安静怠速升到满速（零速不静音）。 */
export function engineVolume(speed: number, maxSpeed: number): number {
  const ratio = clamp01(Math.abs(speed) / Math.max(Math.abs(maxSpeed), 1e-6));
  return IDLE_VOLUME + (MAX_VOLUME - IDLE_VOLUME) * ratio;
}

/** 每帧由运行时喂给的行车状态（maxSpeed 用 DRIVING_PARAMS.maxForward）。 */
export type DrivingSfxTelemetry = Readonly<{
  /** 有符号车速（世界单位/秒）。 */
  speed: number;
  /** 归一化分母（调用方传 DRIVING_PARAMS.maxForward）。 */
  maxSpeed: number;
  braking: boolean;
  reversing: boolean;
  rainIntensity?: number;
  /** VTOL 推进器强度 [0,1]：冷气嘶声层（非 VTOL 会话缺省静音）。 */
  thruster?: number;
}>;

type EngineNodes = {
  master: GainNode;
  engineOsc: OscillatorNode;
  engineFilter: BiquadFilterNode;
  subOsc: OscillatorNode;
  subGain: GainNode;
  engineGain: GainNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  brakeGain: GainNode;
  thrusterGain: GainNode;
  noise: AudioBuffer;
  rainGain: GainNode;
};

export class DrivingSfx {
  private ctx: AudioContext | null = null;
  private channel: GameAudioChannel | null = null;
  private suspended = true;
  private volume = 1;
  private lastCollisionAt = -Infinity;
  private nodes: EngineNodes | null = null;
  private muted = false;
  private disposed = false;
  /** 下次倒车蜂鸣的上下文时刻（0 = 待重整）。 */
  private nextReverseBeepAt = 0;

  constructor(private readonly audioService: GameAudioService = gameAudioService) {}

  get available(): boolean { return !this.disposed && this.audioService.available; }
  private ensureGraph(): void {
    if (this.disposed || this.nodes && this.channel?.isCurrent()) return;
    this.channel?.release(); this.channel = this.audioService.acquire();
    this.ctx = this.channel?.context ?? null; this.nodes = null;
    if (!this.ctx || !this.channel) return;
    try { this.nodes = this.build(this.ctx); }
    catch { this.channel.release(); this.channel = null; this.ctx = null; }
  }
  start(): void {
    if (this.disposed) return;
    this.suspended = false; this.ensureGraph(); this.applyMasterGain(0.02);
    this.channel?.setActive(true);
  }
  resume(): void { this.start(); }
  suspend(): void { this.suspended = true; this.nextReverseBeepAt = 0; this.channel?.setActive(false); }
  stop(): void {
    this.suspend(); this.channel?.release(); this.channel = null; this.ctx = null; this.nodes = null;
    this.lastCollisionAt = -Infinity;
  }
  setVolume(value: number): void { this.volume = Number.isFinite(value) ? clamp01(value) : 0; this.applyMasterGain(0.02); }

  get isMuted(): boolean {
    return this.muted;
  }

  private gainTarget(): number {
    return this.muted || this.suspended ? 0 : MASTER_GAIN * this.volume;
  }

  private applyMasterGain(_tau: number): void { this.channel?.setGain(this.gainTarget()); }

  setMuted(value: boolean): void {
    this.muted = value;
    this.applyMasterGain(0.02);
  }

  /** 每帧驱动连续声部：引擎音高/音量、刹车噪声层、倒车蜂鸣调度。 */
  update(telemetry: DrivingSfxTelemetry): void {
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes || this.disposed || this.suspended) return;
    const t = ctx.currentTime;

    // 引擎音高：连续映射 + 倒车整体下移 20%（setTargetAtTime 完成参数平滑）。
    let freq = engineFrequency(telemetry.speed, telemetry.maxSpeed);
    if (telemetry.reversing) freq *= REVERSE_PITCH_FACTOR;
    nodes.engineOsc.frequency.setTargetAtTime(freq, t, 0.08);
    nodes.subOsc.frequency.setTargetAtTime(freq / 2, t, 0.08);
    // 音量：怠速安静、满速更响（零速不静音）。
    nodes.engineGain.gain.setTargetAtTime(engineVolume(telemetry.speed, telemetry.maxSpeed), t, 0.1);

    // 刹车：滤波白噪声层，短包层起落（静止时刹车不嘶鸣）。
    const brakingHard = telemetry.braking && Math.abs(telemetry.speed) > BRAKE_MIN_SPEED;
    nodes.brakeGain.gain.setTargetAtTime(brakingHard ? 0.22 : 0, t, brakingHard ? 0.03 : 0.08);

    nodes.rainGain.gain.setTargetAtTime(clamp01(telemetry.rainIntensity ?? 0) * 0.12, t, 0.5);
    // VTOL 冷气喷流：高通嘶声层，强度随推进器（快速起音、稍慢收音）。
    nodes.thrusterGain.gain.setTargetAtTime(clamp01(telemetry.thruster ?? 0) * 0.22, t, (telemetry.thruster ?? 0) > 0 ? 0.03 : 0.12);

    // 倒车蜂鸣：800Hz、250ms 开 / 250ms 关；离开倒车即重整。
    if (telemetry.reversing) {
      if (this.nextReverseBeepAt === 0) this.nextReverseBeepAt = t;
      if (t >= this.nextReverseBeepAt) {
        this.nextReverseBeepAt = t + REVERSE_BEEP_PERIOD;
        this.tone(REVERSE_BEEP_HZ, 0, REVERSE_BEEP_DURATION, 0.12);
      }
    } else if (this.nextReverseBeepAt !== 0) {
      this.nextReverseBeepAt = 0;
    }
  }

  /** 碰撞一次性音：滤波噪声爆发 + 低频正弦闷击，150ms 衰减。 */
  collision(): void {
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes || this.disposed || this.suspended) return;
    const t = ctx.currentTime;
    if (t - this.lastCollisionAt < 0.15) return;
    this.lastCollisionAt = t;
    const burst = this.channel!.source(ctx.createBufferSource());
    burst.buffer = nodes.noise;
    const bp = this.channel!.node(ctx.createBiquadFilter());
    bp.type = "bandpass";
    bp.frequency.value = 420;
    bp.Q.value = 0.7;
    const g = this.channel!.node(ctx.createGain());
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    burst.connect(bp).connect(g).connect(nodes.master);
    this.channel!.source(burst, [bp, g]);
    burst.start(t, Math.random());
    burst.stop(t + 0.16);
    // 低频闷击（thump）。
    this.tone(64, 0, 0.15, 0.3);
  }

  /** Release only this channel, including every loop and transient source. */
  dispose(): void { if (this.disposed) return; this.stop(); this.disposed = true; }

  /** 短音（蜂鸣/闷击共用）：8ms 指数起音 + 指数衰减。 */
  private tone(freq: number, delay: number, dur: number, peak: number): void {
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes || this.disposed || this.suspended) return;
    const t = ctx.currentTime + delay;
    const osc = this.channel!.source(ctx.createOscillator());
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = this.channel!.node(ctx.createGain());
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(nodes.master);
    this.channel!.source(osc, [g]);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private build(ctx: AudioContext): EngineNodes {
    const master = this.channel!.output;

    // 共享白噪声缓冲（刹车层与碰撞爆发取样源）。
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    // 引擎主体：锯齿（粗糙感）经低通塑形。
    const engineOsc = this.channel!.source(ctx.createOscillator());
    engineOsc.type = "sawtooth";
    engineOsc.frequency.value = IDLE_FLOOR;
    const engineFilter = this.channel!.node(ctx.createBiquadFilter());
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 900;
    engineFilter.Q.value = 1.1;
    // 副低频：正弦低八度，车身/座椅体感轰鸣。
    const subOsc = this.channel!.source(ctx.createOscillator());
    subOsc.type = "sine";
    subOsc.frequency.value = IDLE_FLOOR / 2;
    const subGain = this.channel!.node(ctx.createGain());
    subGain.gain.value = 0.7;
    // 引擎总音量（update 按车速驱动）。
    const engineGain = this.channel!.node(ctx.createGain());
    engineGain.gain.value = IDLE_VOLUME;
    engineOsc.connect(engineFilter).connect(engineGain);
    subOsc.connect(subGain).connect(engineGain);
    engineGain.connect(master);
    engineOsc.start();
    subOsc.start();

    // LFO 颤动：8Hz 正弦经深度增益（±2Hz）调制两个振荡器的频率。
    const lfo = this.channel!.source(ctx.createOscillator());
    lfo.type = "sine";
    lfo.frequency.value = LFO_HZ;
    const lfoDepth = this.channel!.node(ctx.createGain());
    lfoDepth.gain.value = LFO_DEPTH_HZ;
    lfo.connect(lfoDepth);
    lfoDepth.connect(engineOsc.frequency);
    lfoDepth.connect(subOsc.frequency);
    lfo.start();

    // 刹车层：循环白噪声经带通，增益由 update 短包层驱动（初始静默）。
    const brakeNoise = this.channel!.source(ctx.createBufferSource());
    brakeNoise.buffer = noise;
    brakeNoise.loop = true;
    const brakeFilter = this.channel!.node(ctx.createBiquadFilter());
    brakeFilter.type = "bandpass";
    brakeFilter.frequency.value = 1600;
    brakeFilter.Q.value = 0.6;
    const brakeGain = this.channel!.node(ctx.createGain());
    brakeGain.gain.value = 0;
    brakeNoise.connect(brakeFilter).connect(brakeGain).connect(master);
    brakeNoise.start();

    const rain = this.channel!.source(ctx.createBufferSource());
    rain.buffer = noise; rain.loop = true;
    const rainFilter = this.channel!.node(ctx.createBiquadFilter());
    rainFilter.type = "highpass"; rainFilter.frequency.value = 3800;
    const thrusterSource = this.channel!.source(ctx.createBufferSource());
    thrusterSource.buffer = noise; thrusterSource.loop = true;
    const thrusterFilter = this.channel!.node(ctx.createBiquadFilter());
    thrusterFilter.type = "highpass"; thrusterFilter.frequency.value = 2600; thrusterFilter.Q.value = 0.7;
    const thrusterGain = this.channel!.node(ctx.createGain()); thrusterGain.gain.value = 0;
    thrusterSource.connect(thrusterFilter).connect(thrusterGain).connect(master);
    thrusterSource.start();
    const rainGain = this.channel!.node(ctx.createGain()); rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(rainGain).connect(master); rain.start();

    return { rainGain, thrusterGain, master, engineOsc, engineFilter, subOsc, subGain, engineGain, lfo, lfoDepth, brakeGain, noise };
  }
}
