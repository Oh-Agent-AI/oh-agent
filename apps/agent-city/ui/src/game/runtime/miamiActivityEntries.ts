/**
 * Pure command-to-entry adapter for the Miami legacy activities. CityApp can
 * inject existing hook commands here without this module importing React or
 * changing how the activities start/stop. The SDK registry consumes the
 * resulting entries.
 */
import type {
  GameRuntimeResultV1,
  GameRuntimeTelemetryV1,
  MiamiActivityIdV1,
  MiamiLegacyActivityHandleV1,
} from "../../../../../../packages/agent-vitals-city-game-runtime/src/index";
import type { MiamiActivityEntriesV1 } from "./miamiActivityHost";

export type MiamiActivityCommandV1 = Readonly<{
  enter: () => void | Promise<unknown>;
  exit: () => void;
  active: () => boolean;
  telemetry: () => GameRuntimeTelemetryV1;
}>;

export type MiamiActivityCommandsV1 = Readonly<Record<MiamiActivityIdV1, MiamiActivityCommandV1>>;

export type MiamiActivityEntryOptionsV1 = Readonly<{ timeoutMs?: number; intervalMs?: number }>;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return predicate();
}

export function createMiamiActivityEntries(commands: MiamiActivityCommandsV1, options: MiamiActivityEntryOptionsV1 = {}): MiamiActivityEntriesV1 {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const intervalMs = Math.max(1, options.intervalMs ?? 50);
  const entries = {} as Record<MiamiActivityIdV1, () => Promise<GameRuntimeResultV1<MiamiLegacyActivityHandleV1>>>;
  for (const activity of ["flight", "driving", "mecha", "cinema"] as const) {
    entries[activity] = async () => {
      const command = commands[activity];
      if (command.active()) return { ok: false, failure: { code: "activity_already_active", message: `${activity} is already active.` } };
      let entered: unknown;
      try { entered = command.enter(); } catch { return { ok: false, failure: { code: "activity_entry_failed", message: `${activity} failed to start.` } }; }
      if (entered && typeof (entered as Promise<unknown>).then === "function") {
        try { await entered; } catch { return { ok: false, failure: { code: "activity_entry_failed", message: `${activity} failed to start.` } }; }
      }
      if (!(await waitUntil(command.active, timeoutMs, intervalMs))) {
        return { ok: false, failure: { code: "activity_entry_timeout", message: `${activity} did not become ready in time.` } };
      }
      let disposed = false;
      return { ok: true, value: Object.freeze({
        telemetry: command.telemetry,
        dispose: () => { if (disposed) return; disposed = true; command.exit(); },
      }) };
    };
  }
  return Object.freeze(entries);
}
