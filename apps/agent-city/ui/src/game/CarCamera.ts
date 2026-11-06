/**
 * CarCamera：汽车追尾相机壳——消费 VehicleChaseCamera 核心，参数按汽车尺度标定。
 * 阻尼比飞机紧（15 vs 4.2）：汽车贴地行驶、速度低、转弯半径小，滞后体感比飞机强。
 * 遮挡与地形查询由调用方注入（开发页用简单 raycast，CityEngine 版查碰撞索引）。
 */
import * as THREE from "three";
import { VehicleChaseCamera, type CameraClearanceQuery, type ChaseCameraSafety, type ChaseOrbitState } from "./VehicleChaseCamera";

export const CAR_ZOOM_MIN = 0.5;
export const CAR_ZOOM_MAX = 3.0;

export type CarChaseTarget = Readonly<{
  x: number; y: number; z: number;
  heading: number;
  speed: number;
  maxSpeed: number;
  /** 净空扫掠起点抬升（y 传支撑面高度时必须传车半高，见 ChaseTarget.sweepLift）。 */
  sweepLift?: number;
}>;

export class CarCamera {
  private readonly core: VehicleChaseCamera;

  constructor(camera: THREE.PerspectiveCamera, reducedMotion: boolean) {
    this.core = new VehicleChaseCamera(camera, {
      positionDamping: 15,       // 紧跟：汽车转弯半径小，滞后体感强
      dragPositionDamping: 20,   // 环绕操作时更紧
      lookDamping: 20,           // 注视点快速跟上
      baseBack: 7.2,
      baseHeight: 4.4,
      speedBackBoost: 0.19,      // 速度满时拉远约 1.4 单位
      lookAhead: 2.5,
      fovBase: 48,
      fovSpeedSpan: 6,           // 速度感（比飞机克制——汽车更"稳"）
      groundMargin: 0.5,         // 相机 y ≥ 地面 + 0.5
      fovDamping: 3,
    }, reducedMotion, {
      zoom: { min: CAR_ZOOM_MIN, max: CAR_ZOOM_MAX },
    });
  }

  get orbit(): ChaseOrbitState {
    return this.core.orbit;
  }

  orbitBy(dYaw: number, dPitch: number): void {
    this.core.orbitBy(dYaw, dPitch);
  }

  zoomBy(factor: number): void {
    this.core.zoomBy(factor);
  }

  setDragging(dragging: boolean): void {
    this.core.setDragging(dragging);
  }

  resetOrbit(includeZoom = true): void {
    this.core.resetOrbit(includeZoom);
  }

  reset(target: CarChaseTarget): void {
    this.core.reset(this.toRatio(target));
  }

  update(dt: number, target: CarChaseTarget, queries?: {
    occlusion?: (x: number, y: number, z: number) => boolean;
    terrain?: (x: number, z: number) => number;
    cameraSweep?: CameraClearanceQuery;
  }): ChaseCameraSafety {
    return this.core.update(dt, this.toRatio(target), queries);
  }

  dispose(): void {
    this.core.dispose();
  }

  private toRatio(target: CarChaseTarget) {
    return {
      ...target,
      speedRatio: Math.max(0, Math.min(1, Math.abs(target.speed) / Math.max(target.maxSpeed, 1e-6))),
    };
  }
}
