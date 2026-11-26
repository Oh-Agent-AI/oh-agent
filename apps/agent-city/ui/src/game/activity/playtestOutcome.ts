/** Terminal runtime outcomes must match the host's finish contract. */
export function playtestOutcome(status: "success" | "failure" | "error", reason: string | null): Readonly<{ status: "completed" | "failed"; failureCode?: string }> {
  return status === "success" ? { status: "completed" } : { status: "failed", failureCode: reason ?? "creator_minigame_failed" };
}
