/** UAT-only keyboard driver. No progress writes, teleports or alternate physics. */
import type { GameSession } from "./GameSession";
import type { FlightSimState } from "./FlightSimulation";
import type { RaceCourse } from "./RaceCourse";
import type { CityEngine } from "../engine/CityEngine";

export function startUatPilot(session: GameSession, engine: CityEngine): () => void {
  // Deliberately confined test inspection; not a plugin API or gameplay control.
  const inspect = session as unknown as { sim: FlightSimState | null; course: RaceCourse | null };
  const held = new Set<string>();
  const setKeys = (next: Set<string>) => {
    for (const code of held) if (!next.has(code)) {
      window.dispatchEvent(new KeyboardEvent("keyup", { code })); held.delete(code);
    }
    for (const code of next) if (!held.has(code)) {
      window.dispatchEvent(new KeyboardEvent("keydown", { code })); held.add(code);
    }
  };
  const stop = () => { window.clearInterval(timer); setKeys(new Set()); };
  const timer = window.setInterval(() => {
    const snapshot = session.snapshot();
    const { phase, paused, error } = snapshot.controller;
    if (phase === "data" || phase === "result" || error) { stop(); return; }
    if (paused || document.visibilityState !== "visible") { setKeys(new Set()); return; }
    const state = inspect.sim;
    const target = inspect.course?.rings[snapshot.mission?.targetIndex ?? 0];
    if (!state || !target || phase !== "racing") { setKeys(new Set()); return; }
    if (engine.domCanvas instanceof HTMLCanvasElement) engine.domCanvas.focus({ preventScroll: true });
    const angle = Math.atan2(target.z - state.z, target.x - state.x) - state.heading;
    const errorAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
    const correction = errorAngle - state.turnRate * 0.13;
    const next = new Set<string>();
    // correction > 0 = 目标在航向增大一侧 = 屏幕右侧 → D。
    if (correction > 0.015) next.add("KeyD");
    else if (correction < -0.015) next.add("KeyA");
    const heightError = target.y - state.y - state.verticalSpeed * 0.18;
    if (heightError > 0.15) next.add("ArrowUp");
    else if (heightError < -0.15) next.add("ArrowDown");
    if (Math.abs(errorAngle) > 0.4) next.add("KeyS");
    setKeys(next);
  }, 16);
  return stop;
}
