/**
 * 游戏模式状态机（§5）：data → preparing → practice | countdown → racing → result → exiting → data，
 * paused/error 为叠加态。本类纯逻辑、零副作用：方法返回事件列表，副作用（相机、输入、
 * 场景清理、HUD）由调用方按事件执行；非法命令是“无事件 + 状态不变”的合并操作，
 * 不抛异常——宿主的重复进入/退出命令（§5 互斥表）必须折叠成无操作，不创建第二实例。
 */
import type {
  EnterHostState, EnterRefusal, FalliblePhase, GameEvent, GameErrorState, GamePauseReason,
  GamePausedState, GamePhase, GameSelection, PausablePhase,
} from "./types";

export type GameSnapshot = {
  phase: GamePhase;
  paused: GamePausedState | null;
  error: GameErrorState | null;
  selection: GameSelection | null;
  /** 每次进入/重试唯一递增；结算（race-finished 与成绩落盘）只对当前 runId 生效一次。 */
  runId: number;
};

const PAUSABLE: readonly PausablePhase[] = ["practice", "countdown", "racing"];

function isPausable(phase: GamePhase): phase is PausablePhase {
  return (PAUSABLE as readonly string[]).includes(phase);
}

export class GameModeController {
  private state: GameSnapshot = { phase: "data", paused: null, error: null, selection: null, runId: 0 };

  get snapshot(): Readonly<GameSnapshot> {
    return this.state;
  }

  get inGame(): boolean {
    return this.state.phase !== "data";
  }

  /** 模拟是否推进（未被暂停/错误覆盖，且处于会推进飞机的阶段）。 */
  get simulating(): boolean {
    const { phase, paused, error } = this.state;
    return isPausable(phase) && !paused && !error;
  }

  /** 进入游戏。城市未就绪/宿主互斥/重复进入 → 拒绝并给出可识别原因。 */
  enter(kind: GameSelection, host: EnterHostState): { ok: true; events: GameEvent[] } | { ok: false; refusal: EnterRefusal } {
    if (this.state.phase !== "data") return { ok: false, refusal: "already-in-game" };
    if (!host.cityReady) return { ok: false, refusal: "not-ready" };
    if (host.cinemaActive) return { ok: false, refusal: "cinema-active" };
    if (host.filmActive) return { ok: false, refusal: "film-active" };
    if (host.busy) return { ok: false, refusal: "busy" };
    this.state = { phase: "preparing", paused: null, error: null, selection: kind, runId: this.state.runId + 1 };
    return { ok: true, events: [{ type: "entered", kind }] };
  }

  /** 准备完成（布局/出生点/路线就绪）：练习直接起飞，挑战进入倒计时。 */
  prepareDone(): GameEvent[] {
    const { phase, error, selection } = this.state;
    if (phase !== "preparing" || error || !selection) return [];
    const events: GameEvent[] = [];
    if (selection.mode === "practice") {
      this.state = { ...this.state, phase: "practice" };
      events.push({ type: "prepared", kind: selection });
    } else {
      this.state = { ...this.state, phase: "countdown" };
      events.push({ type: "prepared", kind: selection }, { type: "countdown-started" });
    }
    return events;
  }

  /** 倒计时结束（G2 的任务计时驱动）。 */
  countdownDone(): GameEvent[] {
    const { phase, paused, error } = this.state;
    if (phase !== "countdown" || paused || error) return [];
    this.state = { ...this.state, phase: "racing" };
    return [{ type: "race-started" }];
  }

  /** 任务终态（完成或超时）：同一 runId 只结算一次。 */
  raceFinished(): GameEvent[] {
    const { phase, paused, error } = this.state;
    if (phase !== "racing" || paused || error) return [];
    this.state = { ...this.state, phase: "result" };
    return [{ type: "race-finished" }];
  }

  /** 暂停（含宿主隐藏/焦点丢失/菜单/长帧/上下文丢失）。已暂停时只更新来源，不重复入栈。 */
  pause(reason: GamePauseReason): GameEvent[] {
    const { phase, paused, error } = this.state;
    if (!isPausable(phase) || error) return [];
    if (paused) {
      if (paused.reason === reason) return [];
      this.state = { ...this.state, paused: { reason, origin: paused.origin } };
      return [{ type: "paused", reason, origin: paused.origin }];
    }
    this.state = { ...this.state, paused: { reason, origin: phase } };
    return [{ type: "paused", reason, origin: phase }];
  }

  /** 继续游戏。焦点重确认/清空旧键值是调用方的职责（§5：恢复需重新确认焦点）。 */
  resume(): GameEvent[] {
    const { paused, error } = this.state;
    if (!paused || error) return [];
    this.state = { ...this.state, paused: null };
    return [{ type: "resumed" }];
  }

  /** 重新开始/重试：暂停面板与结果面板均可达；复用原路线（G2：variant 不变）。
   *  错误面板的重试走 retryPrepare（语义不同：回到 preparing 等待重新准备）。 */
  restart(): GameEvent[] {
    const { phase, paused, error, selection, runId } = this.state;
    if (!selection || error || phase === "data" || phase === "preparing" || phase === "exiting") return [];
    if (!paused && phase !== "result") return [];
    this.state = { phase: "preparing", paused: null, error: null, selection, runId: runId + 1 };
    return [{ type: "restarted", kind: selection }, ...this.prepareDone()];
  }

  /** 准备或运行错误 → 可恢复错误面板（§5）。 */
  fail(message: string): GameEvent[] {
    const { phase, error } = this.state;
    if (error) return [];
    if (phase !== "preparing" && !isPausable(phase)) return [];
    const origin: FalliblePhase = phase as FalliblePhase;
    this.state = { ...this.state, error: { message, origin } };
    return [{ type: "failed", message, origin }];
  }

  /** 错误面板 → 重试准备（同一玩法）。 */
  retryPrepare(): GameEvent[] {
    const { error, selection, runId } = this.state;
    if (!error || !selection) return [];
    this.state = { phase: "preparing", paused: null, error: null, selection, runId: runId + 1 };
    return [{ type: "retry-prepare" }];
  }

  /** 退出游戏（幂等）：进入 exiting，调用方完成清理后调 exitSettled 落回 data。 */
  exit(): GameEvent[] {
    const { phase } = this.state;
    if (phase === "data" || phase === "exiting") return [];
    this.state = { ...this.state, phase: "exiting", paused: null, error: null };
    return [{ type: "exit-began" }];
  }

  /** 退出清理完成：exiting → data。重复调用无操作（不重复恢复/保存）。 */
  exitSettled(): GameEvent[] {
    if (this.state.phase !== "exiting") return [];
    this.state = { phase: "data", paused: null, error: null, selection: null, runId: this.state.runId };
    return [{ type: "exited" }];
  }
}
