import type { TurnEvent } from "./rules";

export type FizzledAction = Extract<TurnEvent, { type: "act" }>;

/** Only the authoritative simulation can tell us whether an action fizzles. */
export function forecastFizzles(log: readonly TurnEvent[]): FizzledAction[] {
  return log.filter((event): event is FizzledAction => event.type === "act" && event.fizzled === true);
}
