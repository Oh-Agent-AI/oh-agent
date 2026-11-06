/** Count actual post-reservation addresses; never a network/model safety proof. */
export type LayoutCapacityInput = {
  parcelIds: readonly string[]; usedParcelIds: readonly string[];
  sessionIds: readonly string[]; assignments: readonly (readonly [string, string])[];
  aggregatedSessionCount: number;
};
export function measureLayoutCapacity(input: LayoutCapacityInput) {
  const parcels = new Set(input.parcelIds), sessions = new Set(input.sessionIds);
  const assignedSessions = new Set<string>(), assignedParcels = new Set<string>(), reasons: string[] = [];
  if (parcels.size !== input.parcelIds.length) reasons.push("duplicate parcel ids");
  if (sessions.size !== input.sessionIds.length) reasons.push("duplicate session ids");
  for (const [sessionId, parcelId] of input.assignments) {
    if (!sessions.has(sessionId) || !parcels.has(parcelId)) reasons.push("assignment references an unknown session or parcel");
    if (assignedSessions.has(sessionId) || assignedParcels.has(parcelId)) reasons.push("duplicate assignment ownership");
    assignedSessions.add(sessionId); assignedParcels.add(parcelId);
  }
  const used = new Set(input.usedParcelIds);
  if ([...used].some(id => !parcels.has(id))) reasons.push("reservation references an unknown parcel");
  if ([...assignedParcels].some(id => !used.has(id))) reasons.push("assigned parcel is not marked occupied");
  const reservedParcelIds = [...used].filter(id => parcels.has(id) && !assignedParcels.has(id)).sort();
  const unassignedSessionIds = [...sessions].filter(id => !assignedSessions.has(id)).sort();
  const aggregated = input.aggregatedSessionCount;
  if (!Number.isSafeInteger(aggregated) || aggregated < 0 || aggregated > unassignedSessionIds.length) reasons.push("invalid aggregate session count");
  const representedAggregate = Number.isSafeInteger(aggregated) && aggregated >= 0 ? Math.min(aggregated, unassignedSessionIds.length) : 0;
  const unrepresentedSessions = unassignedSessionIds.length - representedAggregate;
  return { scope: "post-reservation-address-accounting" as const,
    status: reasons.length ? "invalid" as const : unrepresentedSessions ? "incomplete" as const : "accounted" as const,
    totalAddresses: parcels.size, reservedAddresses: reservedParcelIds.length, reservedParcelIds,
    availableForSessions: parcels.size - reservedParcelIds.length, assignedSessions: assignedSessions.size,
    freeAddresses: [...parcels].filter(id => !used.has(id)).length, requiredSessions: input.sessionIds.length,
    unassignedSessionIds, aggregatedSessions: representedAggregate, unrepresentedSessions, reasons,
    coverage: "aggregate-count-only-not-individual-provenance-or-physical-capacity" as const };
}
