/** In-memory approval gate for Agent project commits. The host still enforces
 * preview ownership, expiration, revision and operation idempotency. */
export type AgentProposal = Readonly<{ projectId: string; previewId: string; revision: number; kind: "game" | "scene"; summary: string; details: readonly string[]; changes: string; requiresCityPreview?: boolean; cityPatch?: unknown; expiresAt: number }>;
export type AgentCommit = Readonly<{ method: string; projectId: string; previewId: string; expectedRevision: number; operationId: string; proposal: AgentProposal }>;

/** Check the live baseline, rather than comparing the modified road network. */
export function matchesPreviewBase(engine: { readonly currentSeed: number | null; getCitySdkLayoutView(): { readonly worldRevision: string } | null } | null, seed: number, worldRevision: string): boolean {
  try { return !!engine && engine.currentSeed === seed && engine.getCitySdkLayoutView()?.worldRevision === worldRevision; }
  catch { return false; }
}

export class AgentApprovalGate {
  private proposals = new Map<string, AgentProposal>();
  private pending: AgentCommit | null = null;

  remember(proposal: AgentProposal, now = Date.now()): void {
    for (const [id, item] of this.proposals) if (item.expiresAt <= now) this.proposals.delete(id);
    if (this.proposals.size >= 64) this.proposals.delete(this.proposals.keys().next().value!);
    this.proposals.set(proposal.previewId, proposal);
  }

  request(method: string, payload: Record<string, unknown>, now = Date.now()): AgentCommit {
    if (this.pending && this.pending.proposal.expiresAt <= now) this.clear(this.pending);
    const { projectId, previewId, expectedRevision, operationId } = payload;
    if (typeof projectId !== "string" || typeof previewId !== "string" || typeof expectedRevision !== "number"
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof operationId !== "string" || !operationId) throw new Error("creator_request_invalid");
    const proposal = this.proposals.get(previewId);
    if (!proposal || proposal.expiresAt <= now) { this.proposals.delete(previewId); throw new Error("creator_approval_preview_unavailable"); }
    if (proposal.projectId !== projectId || proposal.revision !== expectedRevision) throw new Error("creator_approval_scope_mismatch");
    if ((method === "creator.game.commit" && proposal.kind !== "game") || (method === "creator.scene.commit" && proposal.kind !== "scene")) throw new Error("creator_approval_scope_mismatch");
    if (this.pending && (this.pending.previewId !== previewId || this.pending.operationId !== operationId || this.pending.method !== method)) throw new Error("creator_approval_busy");
    return this.pending ??= Object.freeze({ method, projectId, previewId, expectedRevision, operationId, proposal });
  }

  clear(commit: AgentCommit): void {
    if (this.pending === commit) { this.pending = null; this.proposals.delete(commit.previewId); }
  }

  isPending(projectId: unknown, operationId: unknown, now = Date.now()): boolean {
    if (this.pending && this.pending.proposal.expiresAt <= now) this.clear(this.pending);
    return this.pending !== null && this.pending.projectId === projectId && this.pending.operationId === operationId;
  }
}
