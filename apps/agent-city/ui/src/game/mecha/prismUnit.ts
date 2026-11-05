import { emit, type Intent, type MatchState } from "./board";

export const prismUnit = {
  declare(state: MatchState): Intent {
    return { skillId: "prism_guard", targetId: "boss", shieldHits: 1, local: [], projected: [],
      cdSweep: state.boss.cdSweep, status: "planned" };
  },
  project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    if (state.boss.hp <= 0 || intent.targetId !== "boss" || intent.shieldHits !== 1) {
      intent.status = "void"; intent.projected = [];
    } else { intent.status = "reprojected"; intent.projected = []; }
  },
  resolve(state: MatchState, intent: Intent): void {
    if (intent.status !== "void") {
      state.boss.shield = { kind: "prism_guard", hits: 1 };
      emit({ type: "monster_status", actor: "boss", status: "prism_guard", change: "applied", remaining: 1 });
    }
  },
};
