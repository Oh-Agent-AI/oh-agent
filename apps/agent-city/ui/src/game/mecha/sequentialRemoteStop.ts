import type { SequentialSnapshot } from "./contracts/sequentialTransport";

/** Keep the desktop locked on its old state unless phone state is recovered and the host stops. */
export async function stopRemoteAfterRecovery(
  recover: () => Promise<SequentialSnapshot | null>,
  stopHost: () => Promise<unknown>,
  restoreDesktop: (snapshot: SequentialSnapshot) => void,
): Promise<void> {
  const snapshot = await recover();
  if (!snapshot) throw new Error("remote_snapshot_unavailable");
  await stopHost();
  restoreDesktop(snapshot);
}
