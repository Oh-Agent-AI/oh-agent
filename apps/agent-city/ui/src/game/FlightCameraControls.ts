/**
 * FlightCameraControls：游戏画布上的环绕/缩放输入（拖动 = 环绕飞机，滚轮/触控板捏合 = 拉近拉远，
 * 双击 = 复位），手感对齐引擎默认的 OrbitControls（整屏高度拖动 = 一圈）。
 * 只把增量喂给 FlightCamera，自己不碰相机；仅在模拟运行（含倒计时、未暂停）时响应，
 * 暂停/结果面板期间画面停驻，此时的拖动不应在恢复后突然甩镜头。
 * attach/detach 成对注册，与 FlightInput 一致，所有监听可释放。
 */
import type { FlightCamera } from "./FlightCamera";
import type { CarCamera } from "./CarCamera";

/** Either camera shell works—both implement orbitBy/zoomBy/setDragging/resetOrbit via VehicleChaseCamera. */
export type ChaseCameraLike = Pick<FlightCamera, "orbitBy" | "zoomBy" | "setDragging" | "resetOrbit"> | Pick<CarCamera, "orbitBy" | "zoomBy" | "setDragging" | "resetOrbit">;

// 与引擎 OrbitControls（three 0.186）同一条缩放曲线：每 100 滚轮单位 5%（0.95^(Δ/100)），
// 触控板捏合以 ctrlKey+小 deltaY 上报，OrbitControls 将其放大 10 倍；单次事件不设上限但相机缩放有夹取。
const WHEEL_SENSITIVITY = Math.log(1 / 0.95) * 0.01;
const PINCH_MULTIPLIER = 10;
const WHEEL_DELTA_CAP = 2000; // 仅防 1e9 这类畸形值把 exp 推到 Infinity
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 100;

export type FlightCameraControlsOptions = {
  canvas: HTMLElement;
  /** 取当前相机（会话重建相机时无需重新挂载监听）。 */
  camera: () => ChaseCameraLike | null;
  /** 当前是否接受视角输入。 */
  isActive: () => boolean;
};

export class FlightCameraControls {
  private attached = false;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private previousCursor = "";
  private previousTouchAction = "";

  constructor(private readonly options: FlightCameraControlsOptions) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { canvas } = this.options;
    this.previousCursor = canvas.style.cursor;
    canvas.style.cursor = "grab";
    this.previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerEnd);
    canvas.addEventListener("pointercancel", this.onPointerEnd);
    canvas.addEventListener("lostpointercapture", this.onPointerEnd);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const { canvas } = this.options;
    this.endDrag();
    canvas.style.cursor = this.previousCursor;
    canvas.style.touchAction = this.previousTouchAction;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerEnd);
    canvas.removeEventListener("pointercancel", this.onPointerEnd);
    canvas.removeEventListener("lostpointercapture", this.onPointerEnd);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
  }

  private endDrag(): void {
    if (this.pointerId === null) return;
    const id = this.pointerId;
    this.pointerId = null;
    this.options.camera()?.setDragging(false);
    this.options.canvas.style.cursor = "grab";
    try { this.options.canvas.releasePointerCapture?.(id); } catch { /* 指针已随事件结束释放 */ }
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || this.pointerId !== null || !this.options.isActive()) return;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.options.camera()?.setDragging(true);
    this.options.canvas.style.cursor = "grabbing";
    try { this.options.canvas.setPointerCapture?.(event.pointerId); } catch { /* 合成事件无活动指针，忽略 */ }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (!this.options.isActive()) { this.endDrag(); return; }
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    const turn = (2 * Math.PI) / Math.max(1, this.options.canvas.clientHeight);
    // 向右拖 → 相机绕到飞机左侧（像抓住世界向右拽）；向下拖 → 相机升高。
    this.options.camera()?.orbitBy(dx * turn, dy * turn);
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.endDrag();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.options.isActive()) return;
    event.preventDefault(); // 否则宿主页面会跟着滚动/缩放
    const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? PAGE_HEIGHT_PX : 1;
    const raw = event.deltaY * unit * (event.ctrlKey ? PINCH_MULTIPLIER : 1);
    const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, raw));
    this.options.camera()?.zoomBy(Math.exp(delta * WHEEL_SENSITIVITY));
  };

  private readonly onDoubleClick = () => {
    if (!this.options.isActive()) return;
    this.options.camera()?.resetOrbit();
  };
}
