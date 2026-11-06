/** Single entry for manual driving and headless audit. This first implementation
 * wraps the existing arcade model; it does not certify the synthetic world as City.
 */
import { DRIVING_DT, DRIVING_PARAMS, stepDriving, type DrivingEnvironment, type DrivingInputState, type DrivingState, type DrivingMoveResult } from "../DrivingSimulation";
import type { VtolAirMotion, VtolAirResult } from "./vtolDriving";
export { DRIVING_DT } from "../DrivingSimulation";
export type KernelStep = Readonly<{
  state: Readonly<DrivingState>;
  motion: Readonly<{ blocked: boolean; reason: string | null; trajectory?: DrivingMoveResult["trajectory"]; contacts?: DrivingMoveResult["contacts"]; contact?: boolean; queryStatus?: DrivingMoveResult["queryStatus"] }>;
}>;
export type KernelIdentity = Readonly<{
  baseSnapshotHash: string; vehicleConfigHash: string; kernelBuildId: string;
  physicsVersion: number; collisionVersion: number; queryVersion: number;
}>;
/** 可注入的步进函数（默认 stepDriving）。VTOL 会话注入 stepVtolDriving：地面段
 * 行为与默认完全一致（含下方 thruster 透传被 stepDriving 忽略的不变式）。 */
export type KernelStepFn = (previous: DrivingState, input: DrivingInputState, world: DrivingEnvironment) => DrivingState;

export class DrivingKernel {
  readonly identity: KernelIdentity;
  constructor(private readonly world: DrivingEnvironment, identity: KernelIdentity, private readonly stepFn: KernelStepFn = stepDriving) {
    this.identity = Object.freeze({ ...identity });
  }
  step(previous: Readonly<DrivingState>, input: Readonly<DrivingInputState>): KernelStep {
    if (!validDrivingState(previous)) throw new Error("invalid-driving-state");
    let blocked = false; let reason: string | null = null;
    let details: Pick<DrivingMoveResult,"trajectory"|"contacts"|"contact"|"queryStatus"> = {};
    const recordMove = <T extends DrivingMoveResult>(result: T): T => {
      details = {};
      if(result.trajectory&&result.trajectory.length>2048)throw new Error("motion-trajectory-budget");
      if(result.trajectory)details.trajectory=result.trajectory.map(p=>Object.freeze({...p}));
      if(result.contacts)details.contacts=Object.freeze(result.contacts.map(c=>Object.freeze({...c,normal:Object.freeze({...c.normal})})));
      if(result.contact!==undefined)details.contact=result.contact;
      if(result.queryStatus!==undefined)details.queryStatus=result.queryStatus;
      blocked = result.blocked; reason = result.reason ?? null;
      return { ...result } as T;
    };
    // Pass copies to the existing mutable adapter contract. Neither a pilot nor
    // an environment may mutate a live state held by the runner/runtime.
    // 步进函数拿到的是「move 被记账包装、其余成员经原型链直通真实环境」的代理——
    // 注入的 VTOL 物理（lift/moveAir/supportHeight）与默认物理在同一世界对象上可用。
    const proxiedWorld = Object.create(this.world) as DrivingEnvironment;
    proxiedWorld.move = (before, desired) => {
      const result = this.world.move({ ...before }, { ...desired });
      return recordMove(result);
    };
    const airWorld = this.world as DrivingEnvironment & { moveAir?: (before: DrivingState, desired: VtolAirMotion) => VtolAirResult };
    if (typeof airWorld.moveAir === "function") {
      (proxiedWorld as typeof airWorld).moveAir = (before, desired) => recordMove(airWorld.moveAir!({ ...before }, { ...desired }));
    }
    const state = this.stepFn({ ...previous } as DrivingState, {
      forward: input.forward === true, backward: input.backward === true,
      left: input.left === true, right: input.right === true,
      // VTOL 推进器位透传：默认物理（stepDriving）只读四个布尔位，多余字段被忽略（有不变式断言）。
      ...( "thruster" in input ? { thruster: (input as Readonly<{ thruster?: boolean }>).thruster === true } : {}),
    } as DrivingInputState, proxiedWorld);
    if (!validDrivingState(state)) throw new Error("invalid-driving-state");
    const maxStep = Math.max(DRIVING_PARAMS.maxForward, DRIVING_PARAMS.maxReverse) * DRIVING_DT + 1e-6;
    if (Math.hypot(state.x - previous.x, state.z - previous.z) > maxStep) {
      throw new Error("unexpected-position-jump");
    }
    if(details.trajectory) {
      // 这两个界按「本世界合法运动」校准，而不是平地直行的净位移：
      // · 里程：接触滑移/边界滑动的受挡改向让路径长度可超净位移（多段前缀），3× 仍远低于传送级异常。
      // · 3D 位移：支撑面在接缝两侧可合法跳变——桥头引道路面 ↔ 桥面板高差实测 ~0.25，
      //   加纵坡投影（sec 因子，满速 ~0.02）取 0.5 余量。满速过桥头 3D≈0.33，原 0.217 上限必误杀。
      const distance=Math.abs(state.distance-previous.distance);
      if(distance>maxStep*3||Math.hypot(state.x-previous.x,state.y-previous.y,state.z-previous.z)>maxStep+0.5)throw new Error("unexpected-surface-distance-jump");
    }
    return Object.freeze({ state: Object.freeze(state), motion: Object.freeze({ blocked, reason, ...details, ...(details.trajectory?{trajectory:Object.freeze(details.trajectory)}:{}) }) });
  }
}
export function validDrivingState(state: Readonly<DrivingState>): boolean {
  return [state.x, state.y, state.z, state.heading, state.speed, state.steering,
    state.distance, state.pitch, state.roll].every(Number.isFinite) &&
    typeof state.surfaceId === "string" && state.surfaceId.length > 0 &&
    typeof state.braking === "boolean" && typeof state.reversing === "boolean";
}
