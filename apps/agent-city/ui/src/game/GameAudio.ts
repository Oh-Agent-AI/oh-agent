/**
 * GameAudio：游戏模式背景音乐——本地 m4a 直播（1.2 MB，与代码同目录，不进
 * assets 素材目录的 5 MB 预算；离线分发，运行时不联网）。进入 run 启动、
 * 暂停/打断挂起（保留进度）、退出停止回曲首；浏览器自动播放策略被拒时挂
 * 一次性手势监听补放。无 Audio 的环境（Worker/测试桩）退化为无操作——
 * 音乐非必需，静默降级，绝不打断游戏。
 */
import musicUrl from "./leonida-nights.m4a?url";

const MUSIC_VOLUME = 0.35;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class GameAudio {
  private el: HTMLAudioElement | null = null;
  private musicMuted = false;
  /** 主音量（0-1，会话层声音面板），作用于基准音量之上。 */
  private vol = 1;
  /** 会话层挂起（暂停/退出）：与浏览器播放状态无关的自有意图位。 */
  private suspended = true;
  private unlockHandler: (() => void) | null = null;

  get muted(): boolean {
    return this.musicMuted;
  }

  setMuted(value: boolean): void {
    this.musicMuted = value;
    if (!value) this.play();
    else this.el?.pause();
  }

  setVolume(volume: number): void {
    this.vol = clamp01(volume);
    if (this.el) this.el.volume = clamp01(MUSIC_VOLUME * this.vol);
  }

  /** 开始/继续（幂等）：run 挂载与重开路径共用。 */
  start(): void {
    this.suspended = false;
    this.play();
  }

  /** 挂起（暂停/焦点丢失/宿主隐藏）：保留进度。 */
  suspend(): void {
    this.suspended = true;
    this.clearUnlock();
    this.el?.pause();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.play();
  }

  /** 停止（退出游戏）：挂起并回到曲首。 */
  stop(): void {
    this.suspended = true;
    this.clearUnlock();
    const el = this.el;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  }

  dispose(): void {
    this.stop();
    this.el = null;
  }

  private play(): void {
    if (this.musicMuted || this.suspended) return;
    const el = this.element();
    if (!el || !el.paused) return;
    const pending = el.play();
    if (pending && typeof pending.catch === "function") pending.catch(() => this.armUnlock());
  }

  private element(): HTMLAudioElement | null {
    if (typeof Audio === "undefined") return null;
    if (!this.el) {
      this.el = new Audio(musicUrl);
      this.el.loop = true;
      this.el.volume = clamp01(MUSIC_VOLUME * this.vol);
      this.el.preload = "auto";
    }
    return this.el;
  }

  /** 自动播放被拒（无手势上下文）：等下一次任意点击/按键补放，不重入。 */
  private armUnlock(): void {
    if (this.unlockHandler || this.suspended) return;
    const unlock = () => {
      this.clearUnlock();
      this.play();
    };
    this.unlockHandler = unlock;
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });
  }

  private clearUnlock(): void {
    const handler = this.unlockHandler;
    this.unlockHandler = null;
    if (!handler) return;
    window.removeEventListener("pointerdown", handler, { capture: true } as EventListenerOptions);
    window.removeEventListener("keydown", handler, { capture: true } as EventListenerOptions);
  }
}
