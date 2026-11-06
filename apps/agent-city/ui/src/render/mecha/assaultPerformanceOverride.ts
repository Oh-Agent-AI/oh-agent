import * as THREE from "three";
import { poseMechaModel, type MechaPerformanceOverride } from "./animation";
import { sampleAssaultGait } from "./assaultGait";
import type { AssaultPerformancePlan } from "./assaultPerformance";
import { AssaultTurnIK } from "./assaultTurnIK";
import { AssaultWalkIK } from "./assaultWalkIK";
import { AssaultPoseTransition, captureAssaultPose } from "./assaultPoseTransition";
import { AssaultGroundController, type AssaultPreviewGround } from "./assaultGroundController";

export type { AssaultPreviewGround } from "./assaultGroundController";
type TurnConfig = { crouch: number; lift: number };

export function createAssaultPerformanceOverride(
  root: THREE.Object3D, plan: AssaultPerformancePlan, strideProfile: (phase: number) => number,
  cycleSeconds: number, turnConfig: TurnConfig, ground?: AssaultPreviewGround, initiallyFallen = false,
  walkRetarget?: { baseStride: number; toeStartZ: readonly [number, number]; maxFactor: number },
): MechaPerformanceOverride {
  if (!Number.isFinite(cycleSeconds) || cycleSeconds <= 0) throw new Error("invalid Assault cycle duration");
  if (walkRetarget && (![walkRetarget.baseStride, walkRetarget.maxFactor].every(Number.isFinite) || walkRetarget.baseStride <= 0 || walkRetarget.maxFactor <= 0)) throw new Error("invalid walk retargeting");
  const grounding = ground ? new AssaultGroundController(root, ground) : undefined;
  const walkIK = walkRetarget ? new AssaultWalkIK(root, walkRetarget.toeStartZ) : undefined;
  let activeTurn = "", turn: AssaultTurnIK | undefined, heading = root.rotation.y, fallen = initiallyFallen;
  let activeTransition = "", transition: AssaultPoseTransition | undefined;
  const sampleTurn = (key: string, yaw: number, delta: number, phase: number) => {
    heading = yaw;
    root.rotation.y = yaw;
    poseMechaModel(root, "idle", 0);
    grounding?.align(yaw);
    grounding?.stand();
    if (activeTurn !== key) {
      turn = new AssaultTurnIK(root, turnConfig.crouch, turnConfig.lift);
      activeTurn = key;
    }
    turn!.sample(delta, phase);
  };
  return {
    durations: plan.entries.map((entry) => entry.duration),
    play(index, elapsed) {
      const entry = plan.entries[index]!;
      if (entry.gait) {
        const sample = sampleAssaultGait(entry.gait, elapsed, strideProfile);
        root.position.set(sample.position.x, sample.position.y, sample.position.z);
        if (sample.kind === "turn") {
          const stage = entry.gait.stages.findIndex((value) => elapsed < value.start + value.duration);
          sampleTurn(`${index}:${stage}`, sample.yaw, sample.delta, sample.phase);
        } else if (sample.kind === "transition") {
          if (!ground || !grounding) throw new Error("Assault transition requires ground");
          const stage = entry.gait.stages.findIndex((value) => elapsed < value.start + value.duration), key = `${index}:${stage}`;
          if (activeTransition !== key) {
            activeTurn = "";
            sampleTurn(`${index}:${stage - 1}`, sample.turnYaw, sample.turnDelta, 1);
            grounding.feet(0, 0); grounding.support();
            const from = captureAssaultPose(root);
            root.position.set(sample.position.x, sample.position.y, sample.position.z); root.rotation.y = sample.yaw;
            poseMechaModel(root, "move", 0); grounding.align(sample.yaw); grounding.feet(0, ground.maxDrop); grounding.support();
            const to = captureAssaultPose(root);
            transition = new AssaultPoseTransition(root, from, to, ground);
            activeTransition = key; activeTurn = "";
          }
          heading = sample.yaw;
          transition!.sample(sample.phase);
        } else {
          activeTurn = "";
          heading = sample.yaw;
          root.rotation.y = sample.yaw;
          poseMechaModel(root, "move", sample.phase * cycleSeconds);
          if (sample.kind === "walk" && walkIK && walkRetarget) walkIK.sample(Math.min(walkRetarget.maxFactor, sample.stride / walkRetarget.baseStride));
        }
        return null;
      }
      if (entry.attackTurn) {
        if (elapsed < entry.attackTurn.duration) {
          sampleTurn(`${index}:attack`, entry.attackTurn.yaw, entry.attackTurn.delta, elapsed / entry.attackTurn.duration);
          return null;
        }
        activeTurn = "";
        heading = entry.endYaw;
        root.rotation.y = entry.endYaw;
        return (elapsed - entry.attackTurn.duration) / entry.event.duration;
      }
      activeTurn = "";
      if (entry.event.actor === "Assault" && entry.event.kind === "attack") heading = entry.endYaw;
      return elapsed / entry.duration;
    },
    settle(index) {
      activeTurn = "";
      heading = plan.entries[index]!.endYaw;
      if (plan.entries[index]!.event.actor === "Assault" && plan.entries[index]!.event.kind === "death") fallen = true;
      root.rotation.y = heading;
    },
    afterPose(index, elapsed) {
      if (!ground || !grounding) return;
      const entry = index === null ? undefined : plan.entries[index]!;
      const gait = entry?.gait ? sampleAssaultGait(entry.gait, elapsed, strideProfile) : undefined;
      if (gait?.kind === "transition") return;
      const turning = gait?.kind === "turn" || !!(entry?.attackTurn && elapsed < entry.attackTurn.duration);
      if (!turning) {
        const knockback = entry?.event.actor === "Assault" && entry.event.kind === "knockback";
        const pulse = knockback ? Math.sin(Math.PI * Math.max(0, Math.min(1, elapsed / entry.duration))) : 0;
        // Ground alignment changes Euler angles; keep the planned heading while sliding.
        grounding.align(gait?.yaw ?? heading, pulse * .6, -pulse * .18);
      }
      if (fallen || (entry?.event.actor === "Assault" && entry.event.kind === "death")) return;
      if (!entry) poseMechaModel(root, "idle", elapsed);
      const reacting = entry?.event.kind === "attack" && entry.event.targetIds.includes("Assault");
      if (!entry || (entry.event.actor !== "Assault" && !reacting)) {
        grounding.stand();
        return;
      }
      grounding.feet(gait?.kind === "walk" ? gait.phase : 0, gait?.kind === "walk" ? ground.maxDrop : 0);
      if (gait?.kind === "turn" || gait?.kind === "walk" || turning) grounding.support();
    },
  };
}
