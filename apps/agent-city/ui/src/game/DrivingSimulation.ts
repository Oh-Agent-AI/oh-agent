/** Fixed-step arcade bicycle model. No renderer, DOM, input listeners or persistence.
 * World units are deliberately not labelled metres or km/h. heading 0 points toward +X.
 */
import { CAR_DIMENSIONS } from "./carDimensions";

export const DRIVING_PHYSICS_VERSION = 3;
export const DRIVING_DT = 1 / 60;
export const DRIVING_PARAMS = Object.freeze({
  wheelbase: CAR_DIMENSIONS.wheelbase, maxForward: 13, maxReverse: 4, acceleration: 5.5,
  reverseAcceleration: 3, braking: 12, coastDrag: 1.2, maxSteering: 0.48,
  steeringResponse: 8, zeroSpeed: 0.08, slopeGravity: 6, staticHold: 2,
  // 回正倍率：松舵/减小转向时逼近 target 的速率 = steeringResponse × 此值。
  // 赛车手感惯例是回正快于打舵（方向盘自回正），1 = 旧行为（对称单速率）。
  steeringReturnResponse: 1.33,
});
export type DrivingInputState = { forward: boolean; backward: boolean; left: boolean; right: boolean };
export const EMPTY_DRIVING_INPUT: DrivingInputState = { forward: false, backward: false, left: false, right: false };
export type DrivingState = {
  x: number; y: number; z: number; heading: number; speed: number;
  steering: number; distance: number; braking: boolean; reversing: boolean;
  pitch: number; roll: number; surfaceId: string;
};
export type DrivingMotion = { x: number; z: number; heading: number; travelBudget?: number };
export type DrivingTrajectoryPose = DrivingMotion & {y:number;pitch:number;roll:number;surfaceId:string};
export type DrivingContact = Readonly<{obstacleId:string;worldRevision:string;time:number;timeUpper:number;
  normal:Readonly<{x:number;y:number;z:number}>;kind:"translation"|"rotation"}>;
export type DrivingMoveResult = DrivingMotion & {
  y: number; pitch: number; roll: number; surfaceId: string;
  blocked: boolean; reason?: string;
  /** C adapter supplies measured support-path length and retained speed. Legacy
   * worlds keep the endpoint 3D chord fallback. No audit trusts these by themselves. */
  travelledDistance?: number; speedFraction?: number;
  trajectory?: readonly Readonly<DrivingTrajectoryPose>[];
  contacts?: readonly DrivingContact[];
  contact?: boolean; queryStatus?: "resolved" | "unresolved";
};
export interface DrivingEnvironment {
  move(previous: DrivingState, desired: DrivingMotion): DrivingMoveResult;
}
export function initialDrivingState(x = 0, z = 0, heading = 0, surfaceId = "pad"): DrivingState {
  return { x, y: 0, z, heading, speed: 0, steering: 0, distance: 0,
    braking: false, reversing: false, pitch: 0, roll: 0, surfaceId };
}
const approachZero = (speed: number, amount: number) => Math.sign(speed) * Math.max(0, Math.abs(speed) - amount);

export function stepDriving(previous: DrivingState, input: DrivingInputState, world: DrivingEnvironment): DrivingState {
  const p = DRIVING_PARAMS;
  let speed = previous.speed;
  // `backward` is the keyboard's S pedal too: against forward motion it brakes
  // first, then the held input selects reverse once the car reaches rest.
  const direction = Number(input.forward) - Number(input.backward);
  const opposing = direction !== 0 && Math.sign(speed) !== direction && Math.abs(speed) > p.zeroSpeed;
  const braking = (input.forward && input.backward) || opposing;
  if (braking) speed = approachZero(speed, p.braking * DRIVING_DT);
  else if (direction) {
    // Pass through rest before switching gears; never reverse a moving car in one step.
    if (Math.abs(speed) <= p.zeroSpeed && Math.sign(speed) !== direction) speed = 0;
    speed += direction * (direction > 0 ? p.acceleration : p.reverseAcceleration) * DRIVING_DT;
  } else speed = approachZero(speed, p.coastDrag * DRIVING_DT);
  const gravity = -p.slopeGravity * Math.sin(previous.pitch);
  // Active brake holds at rest; passive parking hold only counters bounded grade.
  const hold = braking || (!direction && Math.abs(previous.speed)<=p.zeroSpeed && Math.abs(gravity)<=p.staticHold);
  if (!hold) speed += gravity * DRIVING_DT;
  speed = Math.max(-p.maxReverse, Math.min(p.maxForward, speed));
  const turn = Number(input.right) - Number(input.left);
  const target = turn * p.maxSteering / (1 + Math.abs(speed) * 0.07);
  // 非对称回正：向更小 |转向| 逼近（松舵/减小舵角）用回正速率；打舵/反向压舵仍用施加速率。
  const returning = Math.abs(target) < Math.abs(previous.steering);
  const response = p.steeringResponse * (returning ? p.steeringReturnResponse : 1);
  const steering = previous.steering + (target - previous.steering) * (1 - Math.exp(-response * DRIVING_DT));
  const horizontalSpeed = speed * Math.cos(previous.pitch);
  const yaw = horizontalSpeed / p.wheelbase * Math.tan(steering) * DRIVING_DT;
  const desired = {
    x: previous.x + Math.cos(previous.heading + yaw / 2) * horizontalSpeed * DRIVING_DT,
    z: previous.z + Math.sin(previous.heading + yaw / 2) * horizontalSpeed * DRIVING_DT,
    heading: previous.heading + yaw, travelBudget: Math.abs(speed)*DRIVING_DT,
  };
  const result = world.move(previous, desired);
  const measured = result.travelledDistance ?? Math.hypot(result.x-previous.x,result.y-previous.y,result.z-previous.z);
  const fraction = result.speedFraction ?? (result.blocked ? 0 : 1);
  if(!Number.isFinite(measured)||measured<0||!Number.isFinite(fraction)||fraction<0||fraction>1)throw new Error("invalid-motion-metrics");
  const travelled = measured * Math.sign(speed);
  return { ...previous, x: result.x, y: result.y, z: result.z,
    heading: result.heading, steering, speed: result.blocked ? 0 : speed * fraction,
    pitch: result.pitch, roll: result.roll, surfaceId: result.surfaceId,
    distance: previous.distance + travelled, braking: braking || result.blocked || !!result.contact,
    reversing: !result.blocked && speed * fraction < -p.zeroSpeed };
}
