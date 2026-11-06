/**
 * 飞机游戏模式：纯类型契约（CITY_GAME_MODE_IMPLEMENTATION_PLAN.md §4/§5）。
 * 本文件不依赖 React/DOM/three/Tauri；GameModeController、FlightSimulation、
 * RaceMission 等纯逻辑模块共享这里的类型，宿主/React 层只做投影。
 */

/** 游戏阶段（§5 状态机）；paused/error 是叠加在 phase 上的覆盖态，不改 phase。 */
export type GamePhase =
  | "data" // 数据视角（未进入游戏）
  | "preparing" // 准备布局/路线/出生点（可失败、可退出）
  | "practice" // 自由练习
  | "countdown" // 挑战倒计时（飞机与任务计时冻结）
  | "racing" // 穿环挑战进行中
  | "result" // 结果面板（输入冻结）
  | "exiting"; // 退出事务进行中（清理后回到 data）

/** 允许被暂停覆盖的阶段。 */
export type PausablePhase = "practice" | "countdown" | "racing";

/** 暂停来源（§5）：user / 宿主隐藏 / 焦点丢失 / 菜单 / 长帧 / WebGL 上下文丢失。 */
export type GamePauseReason = "user" | "host-hidden" | "focus-lost" | "menu" | "lag" | "context-lost" | "camera-safety";

/** 允许进入错误面板（可恢复）的阶段。 */
export type FalliblePhase = "preparing" | PausablePhase;

export type GamePausedState = { reason: GamePauseReason; origin: PausablePhase };
export type GameErrorState = { message: string; origin: FalliblePhase };

/** 进入时的玩法选择：自由练习或穿环挑战。 */
export type GameSelection = { mode: "practice" } | { mode: "race" };

/** 进入游戏时宿主互斥状态（§5 互斥表）；由调用方如实上报，控制器据此拒绝。 */
export type EnterHostState = {
  /** 引擎已有 layout+model（否则无从生成飞行世界）。 */
  cityReady: boolean;
  cinemaActive: boolean;
  filmActive: boolean;
  /** 拍照/换种子等正在进行的忙碌操作。 */
  busy: boolean;
};

/** enterGame 的可识别拒绝原因（§1：失败可识别，不伪造城市）。 */
export type EnterRefusal =
  | "not-ready" // 城市未就绪（布局/模型缺失或投影加载失败）
  | "cinema-active" // 航拍中：先结束航拍
  | "film-active" // 视频导出中
  | "busy" // 忙碌操作进行中
  | "already-in-game"; // 重复进入：合并为无操作

/** 纯输入状态（§3.1）：按 KeyboardEvent.code 映射的持续按住状态。 */
export type FlightInputState = {
  throttleUp: boolean; // W：加速
  throttleDown: boolean; // S：减速
  turnLeft: boolean; // A：左转
  turnRight: boolean; // D：右转
  pitchUp: boolean; // ArrowUp：爬升
  pitchDown: boolean; // ArrowDown：下降
};

export const EMPTY_INPUT: FlightInputState = {
  throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false,
};

/** 控制器对外的事件流：HUD 与引擎层据此做副作用（本模块自身零副作用）。 */
export type GameEvent =
  | { type: "entered"; kind: GameSelection } // preparing 开始
  | { type: "prepared"; kind: GameSelection } // preparing → practice/countdown
  | { type: "countdown-started" } // 进入倒计时（G2 使用）
  | { type: "race-started" } // countdown → racing（G2 使用）
  | { type: "race-finished" } // racing → result（G2 使用；每 runId 只发一次）
  | { type: "restarted"; kind: GameSelection } // 重试/重新开始（复用原路线）
  | { type: "paused"; reason: GamePauseReason; origin: PausablePhase }
  | { type: "resumed" }
  | { type: "failed"; message: string; origin: FalliblePhase } // 进入可恢复错误面板
  | { type: "retry-prepare" } // 错误面板 → 重新准备
  | { type: "exit-began" } // 任意在局状态 → exiting
  | { type: "exited" }; // exiting → data（清理完成后由 exitSettled 触发）

/** 引擎侧相机快照（§8 ReturnState 的相机部分；与 photoView 分开，不共用生命周期）。 */
export type ReturnCameraView = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  /** OrbitControls 在进入前被游戏改动的参数，退出时归还。 */
  controls: {
    minDistance: number;
    maxDistance: number;
    enablePan: boolean;
    zoomToCursor: boolean;
    orbitLockedId: string | null;
  };
};

/** 进入游戏时保存的返回状态（§8）：相机 + 回放游标/播放 + 选择 + 标签。
 *  面板/侧栏状态由 React 层（useCityExperience）自行保存，不进引擎。 */
export type ReturnState = {
  camera: ReturnCameraView;
  cursorMs: number | null;
  playing: boolean;
  selectedId: string | null;
  labelsVisible: boolean;
};
