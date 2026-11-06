/** C's trajectory verifier for B's GateAuditObserver. This does not change audit
 * outcomes: rejected/incomplete physics is simulation-invalid, never road proof. */
import {DRIVING_DT,DRIVING_PARAMS,type DrivingState} from "../DrivingSimulation";
import {validDrivingState,type KernelStep} from "./DrivingKernel";
import type {AuditWorldValidator,StepValidation} from "./audit/contracts";
import type {ContinuousDrivingEnvironment} from "./ContinuousDrivingEnvironment";
export class ContinuousWorldValidator implements AuditWorldValidator {
  constructor(private readonly environment:ContinuousDrivingEnvironment,private readonly corridorProgress:(state:Readonly<DrivingState>)=>number){}
  validateStart(state:Readonly<DrivingState>):StepValidation {
    return validDrivingState(state)&&this.environment.validateTrajectory(state,state,[state])?"valid":"simulation-invalid";
  }
  validate(previous:Readonly<DrivingState>,step:KernelStep):StepValidation {
    const state=step.state,path=step.motion.trajectory;
    // 碰撞求解预算用尽（2026-10-20）：内核原地停下并报 queryStatus "unresolved"，曾一律判 simulation-invalid——
    // 1000/7 窄桥斜接处车身连续擦桥面板侧面，切向滑移耗尽测试预算，审计报成「模拟缺陷」。预算不足是未判定，不是缺陷：
    // 只有停在原位（无行程、航向不变）时才这样归类，带着位移的 unresolved 仍是 simulation-invalid。
    if(step.motion.queryStatus==="unresolved"&&/(^|:)budget$/.test(step.motion.reason??"")&&validDrivingState(previous)&&validDrivingState(state)&&
      state.x===previous.x&&state.z===previous.z&&state.heading===previous.heading)return "budget-exhausted";
    if(!validDrivingState(previous)||!validDrivingState(state)||step.motion.queryStatus!=="resolved"||!path||
      !this.environment.validateTrajectory(previous,state,path))return "simulation-invalid";
    // 里程按内核的计费口径（3D 弧长减接缝支撑跳变，ContinuousDrivingEnvironment.travelCharge）：曾自算 3D 弧长，
    // 内核对 ≤ aliasTolerance 的接缝跳变不计行程后两边差出跳变量，过缝的每一步都被判 simulation-invalid。
    const distance=this.environment.travelCharge(path);
    const maximum=DRIVING_PARAMS.maxForward*DRIVING_DT+1e-6;
    const angular=DRIVING_PARAMS.maxForward/DRIVING_PARAMS.wheelbase*Math.tan(DRIVING_PARAMS.maxSteering)*DRIVING_DT+1e-6;
    if(distance>maximum||Math.abs(Math.abs(state.distance-previous.distance)-distance)>1e-6||
      Math.abs(state.heading-previous.heading)>angular||state.speed>DRIVING_PARAMS.maxForward+1e-6||state.speed< -DRIVING_PARAMS.maxReverse-1e-6||
      step.motion.blocked&&(distance>1e-9||state.heading!==previous.heading))return "simulation-invalid";
    return "valid";
  }
  progress(state:Readonly<DrivingState>):number{return this.corridorProgress(state);}
}
