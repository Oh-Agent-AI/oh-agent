/** Serializable, immutable authority shell. Geometry validation remains a shared-policy caller's job. */
export const WORLD_VERSION_DOMAINS = ["network", "site", "reservation", "terrain", "policy", "model"] as const;
export type WorldVersionDomain = typeof WORLD_VERSION_DOMAINS[number];
export type WorldVersions = Readonly<Record<WorldVersionDomain, number>>;
export type WorldEvidence = {
  readonly id: string;
  readonly dependencies: readonly WorldVersionDomain[];
  readonly versions: WorldVersions;
};
export type ReservationState = "tentative" | "accepted" | "frozen" | "released";
export type WorldPoint = { readonly x: number; readonly z: number };
export type ReservationEnvelope =
  | { readonly type: "polygon"; readonly points: readonly WorldPoint[] }
  | { readonly type: "corridor"; readonly points: readonly WorldPoint[]; readonly width: number }
  | { readonly type: "proxy-circle"; readonly centre: WorldPoint; readonly radius: number; readonly reason: string }
  | { readonly type: "unregistered"; readonly anchor: WorldPoint; readonly reason: string };
export type ReservationPhysical =
  | { readonly status: "verified"; readonly evidence: WorldEvidence }
  | { readonly status: "pending" | "unsupported"; readonly reason: string };
export type Reservation = {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly envelope: ReservationEnvelope;
  readonly layer: string;
  readonly elevation: { readonly min: number; readonly max: number } | { readonly status: "unknown"; readonly reason: string };
  readonly state: ReservationState;
  readonly immutable: boolean;
  readonly required: boolean;
  readonly demandIds: readonly string[];
  readonly physical: ReservationPhysical;
  readonly release?: { readonly reason: string; readonly replacementId?: string; readonly authorizationId?: string };
};
export type WorldDemand = {
  readonly id: string;
  readonly ownerId?: string;
  readonly purpose: string;
  readonly required: boolean;
};
export type WorldDemandBinding = { readonly demandId: string; readonly anchor: string; readonly originAnchor?: string };
export type WorldBudget = {
  readonly limits: Readonly<Record<string, number>>;
  readonly consumed: Readonly<Record<string, number>>;
};
export type PlanningWorld = {
  readonly schemaVersion: 1;
  readonly versions: WorldVersions;
  readonly demands: readonly WorldDemand[];
  readonly demandBindings: readonly WorldDemandBinding[];
  readonly reservations: readonly Reservation[];
  readonly ownerIndex: readonly { readonly ownerId: string; readonly reservationIds: readonly string[] }[];
  readonly budget: WorldBudget;
  /** Version counters are revisions, not proof that an unregistered source is physically validated. */
  readonly sourceStatus: Readonly<Record<WorldVersionDomain, "observed" | "pending">>;
};
export type ReplacementAuthorization = {
  readonly id: string;
  readonly reservationId: string;
  readonly replacementId?: string;
  readonly reason: string;
  /** Every existing reservation for this owner must be explicitly acknowledged. */
  readonly dependencyReservationIds: readonly string[];
  /** Published/frozen addresses require a caller-validated mapping, not implicit relocation. */
  readonly publishedMappingEvidence?: WorldEvidence;
};
export type WorldOperation =
  | { readonly type: "register-demand"; readonly demand: WorldDemand }
  | { readonly type: "bind-demand"; readonly binding: WorldDemandBinding; readonly previousAnchor?: string }
  | { readonly type: "reserve"; readonly reservation: Reservation }
  | { readonly type: "revise-tentative"; readonly reservation: Reservation }
  | { readonly type: "revalidate"; readonly id: string; readonly physical: ReservationPhysical }
  | { readonly type: "transition"; readonly id: string; readonly to: ReservationState;
      readonly physical?: ReservationPhysical; readonly reason?: string;
      readonly replacementId?: string; readonly authorization?: ReplacementAuthorization };
export type WorldPatch = {
  readonly expectedVersions: WorldVersions;
  readonly operations: readonly WorldOperation[];
  /** Non-reservation producers must bump their affected domain in the same accepted patch. */
  readonly changedDomains?: readonly WorldVersionDomain[];
  readonly evidence?: readonly WorldEvidence[];
  readonly charge?: Readonly<Record<string, number>>;
};
export type WorldResult =
  | { readonly ok: true; readonly world: PlanningWorld }
  | { readonly ok: false; readonly reason: string; readonly world: PlanningWorld };

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function versionsFailure(versions: WorldVersions): string | undefined {
  if (!versions || WORLD_VERSION_DOMAINS.some(key => !count(versions[key]))) return "invalid-world-versions";
}
export function worldEvidenceFailure(evidence: WorldEvidence, versions: WorldVersions): string | undefined {
  if (!evidence || !nonempty(evidence.id) || !Array.isArray(evidence.dependencies) ||
      evidence.dependencies.length === 0 || versionsFailure(evidence.versions)) return "invalid-evidence";
  const seen = new Set<string>();
  for (const domain of evidence.dependencies as readonly WorldVersionDomain[]) {
    if (!WORLD_VERSION_DOMAINS.includes(domain) || seen.has(domain)) return "invalid-evidence-dependencies";
    seen.add(domain);
    if (evidence.versions[domain] !== versions[domain]) return `stale-evidence:${evidence.id}:${domain}`;
  }
}
function physicalFailure(physical: ReservationPhysical, versions: WorldVersions, accepted: boolean): string | undefined {
  if (!physical) return "missing-physical-declaration";
  if (physical.status === "verified") {
    const failure = worldEvidenceFailure(physical.evidence, versions);
    if (failure) return failure;
    // Omission cannot turn geometry/model/policy revisions into valid physical evidence.
    for (const domain of WORLD_VERSION_DOMAINS)
      if (!physical.evidence.dependencies.includes(domain)) return `physical-evidence-missing-dependency:${domain}`;
  } else if (physical.status !== "pending" && physical.status !== "unsupported") return "invalid-physical-status";
  else if (!nonempty(physical.reason)) return "missing-physical-reason";
  else if (accepted) return `physical-${physical.status}`;
}
function reservationFailure(r: Reservation, demands: readonly WorldDemand[], versions: WorldVersions): string | undefined {
  if (!r || !nonempty(r.id) || !nonempty(r.ownerId) || !nonempty(r.purpose) || !nonempty(r.layer) ||
      typeof r.immutable !== "boolean" || typeof r.required !== "boolean") return "invalid-reservation-identity";
  if (!["tentative", "accepted", "frozen", "released"].includes(r.state)) return "invalid-reservation-state";
  const e = r.envelope;
  if (!e) return "invalid-reservation-envelope";
  if (e.type === "unregistered") {
    if (!e.anchor || !Number.isFinite(e.anchor.x) || !Number.isFinite(e.anchor.z) || !nonempty(e.reason)) return "invalid-unregistered-envelope";
    if (r.state !== "released" && (r.state !== "tentative" || r.physical?.status === "verified")) return "unregistered-envelope-is-not-physical-proof";
  } else if (e.type === "proxy-circle") {
    if (!e.centre || !Number.isFinite(e.centre.x) || !Number.isFinite(e.centre.z) || !Number.isFinite(e.radius) ||
        e.radius <= 0 || !nonempty(e.reason)) return "invalid-proxy-circle";
    if (r.state !== "released" && (r.state !== "tentative" || r.physical?.status === "verified")) return "proxy-is-not-physical-proof";
  } else if (!Array.isArray(e.points) || e.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.z)))
    return "invalid-reservation-envelope";
  if (e.type === "polygon") {
    if (e.points.length < 3) return "invalid-reservation-polygon";
    let area = 0;
    for (let i = 0; i < e.points.length; i += 1) {
      const a = e.points[i], b = e.points[(i + 1) % e.points.length];
      area += a.x * b.z - b.x * a.z;
    }
    if (!Number.isFinite(area) || Math.abs(area) < 1e-12) return "degenerate-reservation-polygon";
  } else if (e.type === "corridor") {
    if (e.points.length < 2 || !Number.isFinite(e.width) || e.width <= 0 ||
        e.points.every(p => p.x === e.points[0].x && p.z === e.points[0].z)) return "invalid-reservation-corridor";
  } else if (e.type !== "proxy-circle" && e.type !== "unregistered") return "unsupported-reservation-envelope";
  if (!r.elevation) return "invalid-reservation-elevation";
  if ("status" in r.elevation) {
    if (r.elevation.status !== "unknown" || !nonempty(r.elevation.reason)) return "invalid-reservation-elevation";
    if (r.state !== "released" && (r.state !== "tentative" || r.physical?.status === "verified")) return "unknown-elevation-is-not-physical-proof";
  } else if (!Number.isFinite(r.elevation.min) || !Number.isFinite(r.elevation.max) ||
      r.elevation.min > r.elevation.max) return "invalid-reservation-elevation";
  if (!Array.isArray(r.demandIds) || new Set(r.demandIds).size !== r.demandIds.length ||
      r.demandIds.some(id => !nonempty(id) || !demands.some(d => d.id === id))) return "unknown-reservation-demand";
  if (r.demandIds.some(id => demands.some(d => d.id === id && d.ownerId !== undefined && d.ownerId !== r.ownerId)))
    return "reservation-demand-owner-mismatch";
  if (r.required && !r.demandIds.some(id => demands.some(d => d.id === id && d.required)))
    return "required-reservation-without-required-demand";
  if (r.state === "released") {
    if (!r.release || !nonempty(r.release.reason)) return "released-reservation-without-reason";
    if (r.required && !nonempty(r.release.authorizationId)) return "released-required-reservation-without-authorization";
    if (r.immutable) return "immutable-reservation-released";
    // Historical geometry proof may be stale after replacement; never serves as current physical evidence.
    return;
  }
  if (r.release) return "active-reservation-has-release";
  return physicalFailure(r.physical, versions, r.state !== "tentative");
}
function ownerIndex(reservations: readonly Reservation[]): PlanningWorld["ownerIndex"] {
  const owners = new Map<string, string[]>();
  for (const r of reservations) {
    const ids = owners.get(r.ownerId) ?? [];
    ids.push(r.id);
    owners.set(r.ownerId, ids);
  }
  return [...owners].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([ownerId, reservationIds]) => ({ ownerId, reservationIds: reservationIds.sort() }));
}
/** Throws only for invalid initial authority. No default synthetic evidence or version inference. */
export function createPlanningWorld(input: {
  versions: WorldVersions; demands?: readonly WorldDemand[]; reservations?: readonly Reservation[]; budget?: WorldBudget;
  sourceStatus?: PlanningWorld["sourceStatus"];
  demandBindings?: readonly WorldDemandBinding[];
}): PlanningWorld {
  const versions = { ...input.versions };
  const failure = versionsFailure(versions);
  if (failure) throw new Error(failure);
  const demands = (input.demands ?? []).map(d => ({ ...d })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (demands.some(d => !nonempty(d.id) || !nonempty(d.purpose) || typeof d.required !== "boolean" ||
      (d.ownerId !== undefined && !nonempty(d.ownerId))) || new Set(demands.map(d => d.id)).size !== demands.length)
    throw new Error("invalid-demand-catalogue");
  const demandBindings = (input.demandBindings ?? []).map(binding => ({ ...binding }))
    .sort((a, b) => a.demandId < b.demandId ? -1 : a.demandId > b.demandId ? 1 : 0);
  if (new Set(demandBindings.map(binding => binding.demandId)).size !== demandBindings.length ||
      demandBindings.some(binding => !demands.some(d => d.id === binding.demandId) || !nonempty(binding.anchor) ||
        (binding.originAnchor !== undefined && !nonempty(binding.originAnchor)))) throw new Error("invalid-demand-bindings");
  // JSON cloning detaches all nested caller-owned data. Validation rejects non-finite geometry before serialization.
  const source = input.reservations ?? [];
  if (new Set(source.map(r => r.id)).size !== source.length) throw new Error("duplicate-reservation-id");
  for (const r of source) {
    const invalid = reservationFailure(r, demands, versions);
    if (invalid) throw new Error(`${r.id}:${invalid}`);
  }
  const reservations = JSON.parse(JSON.stringify(source)) as Reservation[];
  reservations.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const released of reservations.filter(r => r.required && r.state === "released")) {
    let current = released;
    const visited = new Set<string>();
    while (current.state === "released") {
      if (visited.has(current.id)) throw new Error("cyclic-required-replacement");
      visited.add(current.id);
      const replacement = reservations.find(r => r.id === current.release?.replacementId);
      if (!replacement || !replacement.required || replacement.ownerId !== released.ownerId ||
          replacement.purpose !== released.purpose || released.demandIds.some(id => !replacement.demandIds.includes(id)))
        throw new Error(`required-reservation-not-replaced:${released.id}`);
      current = replacement;
    }
    if (current.state !== "accepted" && current.state !== "frozen") throw new Error(`required-replacement-not-accepted:${released.id}`);
  }
  const budget = input.budget ?? { limits: {}, consumed: {} };
  if (Object.keys(budget.consumed).some(key => !(key in budget.limits)) ||
      Object.entries(budget.limits).some(([key, limit]) => !nonempty(key) || !count(limit) ||
        !count(budget.consumed[key] ?? 0) || (budget.consumed[key] ?? 0) > limit)) throw new Error("invalid-world-budget");
  const sourceStatus = input.sourceStatus ?? { network: "pending", site: "pending", reservation: "pending", terrain: "pending", policy: "pending", model: "pending" };
  if (WORLD_VERSION_DOMAINS.some(domain => sourceStatus[domain] !== "observed" && sourceStatus[domain] !== "pending")) throw new Error("invalid-world-source-status");
  return freeze({ schemaVersion: 1 as const, versions, demands, demandBindings, reservations, ownerIndex: ownerIndex(reservations), sourceStatus: { ...sourceStatus },
    budget: { limits: { ...budget.limits }, consumed: { ...budget.consumed } } });
}

/** Pure transactional publication: any failure returns the identical original world, never a partial draft. */
export function applyWorldPatch(world: PlanningWorld, patch: WorldPatch): WorldResult {
  try { return applyWorldPatchDraft(world, patch); }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "invalid-world-patch", world }; }
}
function applyWorldPatchDraft(world: PlanningWorld, patch: WorldPatch): WorldResult {
  const fail = (reason: string): WorldResult => ({ ok: false, reason, world });
  if (!patch || versionsFailure(patch.expectedVersions) ||
      WORLD_VERSION_DOMAINS.some(key => patch.expectedVersions[key] !== world.versions[key])) return fail("stale-world-patch");
  for (const evidence of patch.evidence ?? []) {
    const failure = worldEvidenceFailure(evidence, world.versions);
    if (failure) return fail(failure);
  }
  const changed = new Set<WorldVersionDomain>(patch.changedDomains ?? []);
  if ([...changed].some(domain => !WORLD_VERSION_DOMAINS.includes(domain))) return fail("unknown-world-domain");
  const versions = { ...world.versions };
  const demands = [...world.demands];
  const demandBindings = new Map(world.demandBindings.map(binding => [binding.demandId, binding]));
  const reservations = new Map(world.reservations.map(r => [r.id, r]));
  const transitions = new Map<string, Extract<WorldOperation, { type: "transition" }>>();
  const consumed = { ...world.budget.consumed };
  for (const [key, amount] of Object.entries(patch.charge ?? {})) {
    if (!Object.hasOwn(world.budget.limits, key) || !count(amount)) return fail(`invalid-budget-charge:${key}`);
    const next = (consumed[key] ?? 0) + amount;
    if (!count(next) || next > world.budget.limits[key]) return fail(`budget-exhausted:${key}`);
    consumed[key] = next;
  }
  // Demand registration runs first: operation order cannot silently erase a promised demand.
  for (const op of patch.operations) if (op.type === "register-demand") {
    const old = demands.find(d => d.id === op.demand.id);
    if (old && !same(old, op.demand)) return fail(`demand-identity-conflict:${op.demand.id}`);
    if (!old) { demands.push(op.demand); changed.add("reservation"); }
  }
  for (const op of patch.operations) {
    if (op.type === "register-demand") continue;
    if (op.type === "bind-demand") {
      const prior = demandBindings.get(op.binding.demandId);
      if (prior && (prior.anchor !== op.previousAnchor || prior.originAnchor !== op.binding.originAnchor))
        return fail(`stale-demand-binding:${op.binding.demandId}`);
      if (!prior && op.previousAnchor !== undefined) return fail(`unknown-demand-binding:${op.binding.demandId}`);
      demandBindings.set(op.binding.demandId, op.binding);
      changed.add("reservation");
    } else if (op.type === "reserve") {
      if (reservations.has(op.reservation.id)) return fail(`reservation-identity-conflict:${op.reservation.id}`);
      if (op.reservation.state !== "tentative") return fail("new-reservation-must-be-tentative");
      reservations.set(op.reservation.id, op.reservation);
      changed.add("reservation");
    } else if (op.type === "revise-tentative") {
      const r = reservations.get(op.reservation.id), next = op.reservation;
      if (!r || r.state !== "tentative" || next.state !== "tentative") return fail(`cannot-revise-reservation:${next.id}`);
      if (r.immutable) return fail(`immutable-reservation:${r.id}`);
      if (r.ownerId !== next.ownerId || r.purpose !== next.purpose || r.required !== next.required ||
          !same(r.demandIds, next.demandIds) || r.immutable !== next.immutable) return fail(`reservation-identity-conflict:${r.id}`);
      reservations.set(r.id, next);
      changed.add("reservation");
    } else if (op.type === "transition") {
      if (transitions.has(op.id)) return fail(`duplicate-reservation-transition:${op.id}`);
      transitions.set(op.id, op);
    } else if (op.type === "revalidate") {
      const r = reservations.get(op.id);
      if (!r || r.state === "released") return fail(`cannot-revalidate-reservation:${op.id}`);
      reservations.set(op.id, { ...r, physical: op.physical });
      changed.add("reservation");
    } else return fail("unknown-world-operation");
  }
  for (const [id, op] of transitions) {
    const r = reservations.get(id);
    if (!r) return fail(`unknown-reservation:${id}`);
    const allowed = (r.state === "tentative" && (op.to === "accepted" || op.to === "released")) ||
      (r.state === "accepted" && (op.to === "frozen" || op.to === "released")) ||
      (r.state === "frozen" && op.to === "released");
    if (!allowed) return fail(`invalid-reservation-transition:${id}:${r.state}:${op.to}`);
    if (r.immutable && op.to === "released") return fail(`immutable-reservation:${id}`);
    if (op.to === "released") {
      if (!nonempty(op.reason)) return fail(`missing-release-reason:${id}`);
      if (r.state !== "tentative" || r.required) {
        const auth = op.authorization;
        if (!auth || !nonempty(auth.id) || !nonempty(auth.reason) || auth.reservationId !== id ||
            auth.replacementId !== op.replacementId) return fail(`missing-replacement-authorization:${id}`);
        const dependencies = world.reservations.filter(other => other.ownerId === r.ownerId && other.state !== "released")
          .map(other => other.id);
        if (!Array.isArray(auth.dependencyReservationIds) || dependencies.some(dep => !auth.dependencyReservationIds.includes(dep)))
          return fail(`incomplete-replacement-dependency-closure:${id}`);
        if (r.state === "frozen") {
          if (!auth.publishedMappingEvidence) return fail(`missing-published-mapping:${id}`);
          const failure = worldEvidenceFailure(auth.publishedMappingEvidence, world.versions);
          if (failure) return fail(failure);
        }
      }
      reservations.set(id, { ...r, state: "released", release: { reason: op.reason,
        ...(op.replacementId ? { replacementId: op.replacementId } : {}),
        ...(op.authorization ? { authorizationId: op.authorization.id } : {}) } });
    } else {
      reservations.set(id, { ...r, state: op.to, physical: op.physical ?? r.physical });
    }
    changed.add("reservation");
  }
  for (const r of reservations.values()) if (r.state === "released" && !world.reservations.some(old => old.id === r.id && old.state === "released")) {
    if (r.required) {
      const replacement = r.release?.replacementId ? reservations.get(r.release.replacementId) : undefined;
      if (!replacement || replacement.id === r.id || !["accepted", "frozen"].includes(replacement.state) ||
          !replacement.required || replacement.ownerId !== r.ownerId || replacement.purpose !== r.purpose ||
          r.demandIds.some(demand => !replacement.demandIds.includes(demand))) return fail(`required-reservation-not-replaced:${r.id}`);
    }
  }
  for (const domain of changed) {
    if (!count(versions[domain] + 1)) return fail(`world-version-overflow:${domain}`);
    versions[domain] += 1;
  }
  // Physical proof must be stamped for the resulting geometry versions. Existing proofs invalidate rather than restamp.
  try {
    const next = createPlanningWorld({ versions, demands, reservations: [...reservations.values()],
      demandBindings: [...demandBindings.values()], sourceStatus: world.sourceStatus, budget: { limits: world.budget.limits, consumed } });
    return { ok: true, world: next };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "invalid-world-draft");
  }
}
