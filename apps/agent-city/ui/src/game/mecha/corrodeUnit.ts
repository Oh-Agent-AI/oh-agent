import { BOARD, living, livingStakeBuildings, manh, corrodeWorld, prepareCorrode, reprojectCorrode, resolveCorrode, emit, type MatchState, type Intent, type Cell } from "./board";

function declare(state: MatchState): Intent {
  const world = corrodeWorld(state);
  const goals = [...living(state).map(m => m.pos), ...livingStakeBuildings(state).flatMap(b => b.cells)];
  const cells: Cell[] = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) cells.push({ x, y });
  cells.sort((a, b) => (goals.length ? Math.min(...goals.map(g => manh(a, g))) - Math.min(...goals.map(g => manh(b, g))) : 0) || a.y - b.y || a.x - b.x);
  for (const target of cells) {
    const corrode = prepareCorrode(state.corrode!, world, { sourceId: "boss", target, durationTurns: 2 });
    if (corrode.status !== "void") return { skillId: "corrode_cell", corrode, local: [], projected: [{ ...target }], cdSweep: state.boss.cdSweep, status: "planned" };
  }
  return { skillId: "corrode_cell", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
}

function project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    if (!state.corrode || !intent.corrode || intent.corrode.sourceId !== "boss" || intent.corrode.durationTurns !== 2) {
      intent.status = "void"; intent.projected = []; return;
    }
    const projection = reprojectCorrode(state.corrode, corrodeWorld(state), intent.corrode);
    intent.corrode = projection;
    intent.projected = projection.projected ? [{ ...projection.projected }] : [];
    intent.status = projection.status;
    return;
}

function resolve(state: MatchState, intent: Intent): void {
    if (intent.status !== "void" && intent.corrode && state.corrode) {
      const result = resolveCorrode(state.corrode, corrodeWorld(state), intent.corrode);
      state.corrode = result.state;
      for (const effect of result.events) if (effect.type === "corrode_created") {
        emit({ type: "corrode_field", change: "created", field: effect.field });
      }
    }
}

export const corrodeUnit = { declare, project, resolve } as const;
