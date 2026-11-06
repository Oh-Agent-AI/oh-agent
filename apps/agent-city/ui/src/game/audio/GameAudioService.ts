/** Shared device ownership for vehicle sound. A channel can mute or release its
 * own graph; only the service suspends the device when every channel is idle. */
export interface GameAudioChannel {
  readonly context: AudioContext;
  readonly output: GainNode;
  isCurrent(): boolean;
  setActive(active: boolean): void;
  setGain(gain: number): void;
  node<T extends AudioNode>(node: T): T;
  source<T extends AudioScheduledSourceNode>(source: T, transientNodes?: readonly AudioNode[]): T;
  release(): void;
}
type ChannelState = { active: boolean; gain: number; output: GainNode; nodes: Set<AudioNode>; sources: Set<AudioScheduledSourceNode> };
export type GameAudioOptions = Readonly<{
  createContext?: () => AudioContext | null;
  schedule?: (callback: () => void, milliseconds: number) => unknown;
  cancel?: (timer: unknown) => void;
}>;
const level = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export class GameAudioService {
  private context: AudioContext | null = null;
  private readonly channels = new Map<symbol, ChannelState>();
  private timer: unknown;
  private generation = 0;
  private disposed = false;
  private failed = false;
  constructor(private readonly options: GameAudioOptions = {}) {}
  get available(): boolean {
    return !this.disposed && !this.failed && (!!this.options.createContext || typeof AudioContext !== "undefined");
  }
  get snapshot(): Readonly<{ channels: number; activeChannels: number; sources: number }> {
    return Object.freeze({ channels: this.channels.size, activeChannels: [...this.channels.values()].filter((state) => state.active).length,
      sources: [...this.channels.values()].reduce((sum, state) => sum + state.sources.size, 0) });
  }
  prewarm(): void { if (this.device()) this.idle(); }
  private device(): AudioContext | null {
    if (this.disposed) return null;
    if (this.context?.state === "closed") this.context = null;
    if (!this.context) {
      try {
        this.context = this.options.createContext ? this.options.createContext() : typeof AudioContext !== "undefined" ? new AudioContext() : null;
        this.failed = !this.context;
      } catch { this.failed = true; return null; }
    }
    return this.context;
  }
  acquire(): GameAudioChannel | null {
    const ctx = this.device();
    if (!ctx) return null;
    let output: GainNode;
    try { output = ctx.createGain(); output.gain.value = 0; output.connect(ctx.destination); }
    catch { this.failed = true; this.idle(); return null; }
    const token = Symbol("game-audio-channel");
    const state: ChannelState = { active: false, gain: 1, output, nodes: new Set([output]), sources: new Set() };
    this.channels.set(token, state);
    const current = () => !this.disposed && this.channels.get(token) === state && ctx.state !== "closed";
    const apply = () => {
      if (!current()) return;
      try { output.gain.cancelScheduledValues(ctx.currentTime); output.gain.setTargetAtTime(state.active ? state.gain : 0, ctx.currentTime, 0.015); }
      catch { /* Unavailable audio never interrupts a vehicle. */ }
    };
    return Object.freeze({ context: ctx, output, isCurrent: current,
      setActive: (active: boolean) => {
        if (!current()) return;
        state.active = active; apply();
        if (active) { this.invalidateIdle(); this.resumeDevice(ctx); } else this.idle();
      },
      setGain: (gain: number) => { if (current()) { state.gain = level(gain); apply(); } },
      node: <T extends AudioNode>(node: T): T => { if (current()) state.nodes.add(node); return node; },
      source: <T extends AudioScheduledSourceNode>(source: T, transientNodes: readonly AudioNode[] = []): T => {
        if (!current()) return source;
        state.sources.add(source); state.nodes.add(source);
        for (const node of transientNodes) state.nodes.add(node);
        source.onended = () => {
          state.sources.delete(source);
          for (const node of [source, ...transientNodes]) { state.nodes.delete(node); try { node.disconnect(); } catch { /* Already released. */ } }
        };
        return source;
      },
      release: () => {
        if (this.channels.get(token) !== state) return;
        // Drop the token before stopping sources: onended can run during cleanup.
        this.channels.delete(token); state.active = false;
        try { output.gain.cancelScheduledValues(ctx.currentTime); output.gain.value = 0; } catch { /* Closed device. */ }
        for (const source of [...state.sources]) { try { source.stop(); } catch { /* Already stopped. */ } }
        for (const node of state.nodes) { try { node.disconnect(); } catch { /* Already disconnected. */ } }
        state.sources.clear(); state.nodes.clear(); this.idle();
      },
    });
  }
  private active(): boolean { return [...this.channels.values()].some((state) => state.active); }
  private invalidateIdle(): void {
    this.generation++;
    if (this.timer !== undefined) {
      if (this.options.cancel) this.options.cancel(this.timer); else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      this.timer = undefined;
    }
  }
  private resumeDevice(ctx: AudioContext): void {
    if (this.disposed || this.context !== ctx || !this.active()) return;
    if (ctx.state === "suspended") {
      try { void ctx.resume().then(() => { if (!this.active()) this.idle(); }).catch(() => undefined); } catch { /* Autoplay denied. */ }
    }
  }
  private idle(): void {
    this.invalidateIdle();
    const ctx = this.context;
    if (!ctx || this.active() || ctx.state === "closed" || this.disposed) return;
    const generation = this.generation;
    const suspend = () => {
      if (this.disposed || generation !== this.generation || this.context !== ctx || this.active()) return;
      this.timer = undefined;
      if (ctx.state !== "running") return;
      try {
        void ctx.suspend().then(() => {
          // A new vehicle may have started while the native suspend was pending.
          if (this.context === ctx && !this.disposed && this.active()) this.resumeDevice(ctx);
        }).catch(() => undefined);
      } catch { /* Unsupported device transition. */ }
    };
    this.timer = this.options.schedule ? this.options.schedule(suspend, 60) : setTimeout(suspend, 60);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.invalidateIdle();
    for (const state of this.channels.values()) {
      for (const source of state.sources) { try { source.stop(); } catch { /* Ended. */ } }
      for (const node of state.nodes) { try { node.disconnect(); } catch { /* Detached. */ } }
    }
    this.channels.clear();
    const ctx = this.context; this.context = null;
    if (ctx && ctx.state !== "closed") { try { void ctx.close().catch(() => undefined); } catch { /* Unsupported. */ } }
  }
}
/** One shared device per page. Hosts/tests may inject a dedicated service. */
export const gameAudioService = new GameAudioService();
