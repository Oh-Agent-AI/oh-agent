import type { ArenaPlan, MatchState, TurnEvent } from "./board";
import type { PresentationStages } from "./presentationSnapshot";

/** A settled local round retained for result review and presentation replay. */
export type MechaRecordedRound = {
  before: MatchState;
  after: MatchState;
  plan: ArenaPlan;
  log: TurnEvent[];
  presentationStages: PresentationStages | null;
};
