/**
 * FlightCamera：飞机相机壳——把飞行特定的参数/世界查询适配到 VehicleChaseCamera 核心。
 * 行为与旧版 FlightCamera 逐点一致（verify-city-game-flight 等守卫保证不回退）。
 * 环绕/缩放输入由 FlightCameraControls 喂进来。
 */
import * as THREE from "three";
import type { FlightSimState, FlightParams } from "./FlightSimulation";
import type { FlightWorld } from "./FlightWorld";
import { VehicleChaseCamera, type ChaseCameraSafety, type ChaseOrbitState } from "./VehicleChaseCamera";

export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 3.5;

export class FlightCamera {
  private readonly core: VehicleChaseCamera;

  constructor(camera: THREE.PerspectiveCamera, reducedMotion: boolean) {
    // 飞机参数锁定为旧版调优值；planeRadius 由 params 在 update 时传入，
    // 但阻尼/FOV/距离比例不随飞机尺寸变化——baseBack/baseHeight 由 GameSession
    // 用 params.planeRadius 计算后传入 reset/update。这里用固定默认值，核心
    // 按绝对距离工作，不需要知道飞机半径。
    this.core = new VehicleChaseCamera(camera, {
      positionDamping: 4.2,
      dragPositionDamping: 14,
      lookDamping: 10,
      baseBack: 13,      // 5.2 × planeRadius(2.5)——GameSession 会用 reset 覆盖
      baseHeight: 6,     // 2.4 × planeRadius(2.5)
      speedBackBoost: 0.35,
      lookAhead: 6,      // 2.4 × planeRadius(2.5)
      fovBase: 52,
      fovSpeedSpan: 8,
      groundMargin: 2.25, // 0.9 × planeRadius(2.5)
      fovDamping: 3,
    }, reducedMotion);
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

  reset(sim: FlightSimState, params: FlightParams): void {
    this.core.reset(this.toTarget(sim, params));
  }

  update(dt: number, sim: FlightSimState, params: FlightParams, world: FlightWorld): ChaseCameraSafety {
    return this.core.update(dt, this.toTarget(sim, params), {
      cameraSweep: (from, to, radius) => world.queryCameraSweep(from, to, radius),
      occlusion: (x, y, z) => world.isPointClear(x, y, z, params.planeRadius * 0.7),
      terrain: (x, z) => world.terrainHeight(x, z),
    });
  }

  dispose(): void {
    this.core.dispose();
  }

  private toTarget(sim: FlightSimState, params: FlightParams) {
    return {
      x: sim.x, y: sim.y, z: sim.z,
      heading: sim.heading,
      speed: sim.speed,
      // 距离拉远用 min→max（旧版 backDistance 公式），FOV 用 cruise→max（旧版 FOV 公式）。
      speedRatio: Math.max(0, Math.min(1, (sim.speed - params.minSpeed) / Math.max(1e-6, params.maxSpeed - params.minSpeed))),
      fovSpeedRatio: Math.max(0, Math.min(1, (sim.speed - params.cruiseSpeed) / Math.max(1e-6, params.maxSpeed - params.cruiseSpeed))),
      backOverride: params.planeRadius * 5.2,
      heightOverride: params.planeRadius * 2.4,
      lookAheadOverride: params.planeRadius * 2.4,
    };
  }
}
