import { GameSdkError } from "../protocol/errors";
import type { GameContextV1, UnsubscribeV1 } from "./types";

/** `setup` may be async because a game may preload declared assets before its
 * first tick. The host does not tick while `prepare()` is pending, so an
 * unrelated `await` cannot shift the simulation by a frame. */
export type GameSetupResultV1 = void | UnsubscribeV1;

export type GameDefinitionV1 = Readonly<{
  id: string;
  setup(context: GameContextV1): GameSetupResultV1 | Promise<GameSetupResultV1>;
}>;

const GAME_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;

/**
 * The single public authoring entry point. It validates the definition shape
 * *now*, at module evaluation time, so a bundle that forgot `export default`
 * fails as `game_entry_invalid` instead of half-starting a run.
 */
export function defineGame(definition: GameDefinitionV1): GameDefinitionV1 {
  if (typeof definition !== "object" || definition === null) {
    throw new GameSdkError("game_entry_invalid", "defineGame() expects an object.", "prepare");
  }
  if (typeof definition.id !== "string" || !GAME_ID.test(definition.id)) {
    throw new GameSdkError(
      "game_entry_invalid",
      "Game id must be a lower-case stable identifier (3..128 chars).",
      "prepare",
    );
  }
  if (typeof definition.setup !== "function") {
    throw new GameSdkError("game_entry_invalid", "Game definition must provide a setup(context) function.", "prepare");
  }
  return Object.freeze({ id: definition.id, setup: definition.setup });
}

export function isGameDefinitionV1(value: unknown): value is GameDefinitionV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { setup?: unknown }).setup === "function"
  );
}
