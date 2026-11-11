import type { SequentialTurn } from "../sequentialTurn";
import type { CommandIntent } from "./commandPolicy";

/** A squad policy observes the authoritative command engine and returns one command. */
export type SequentialPolicy = (authority: SequentialTurn) => CommandIntent;
