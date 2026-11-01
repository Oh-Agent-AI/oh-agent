/** Presentation-only policy. Never changes city geometry, rules or user settings. */
export function battleClarityPresentation(active: boolean) {
  return {
    showLabels: !active,
    showStreetPools: !active,
    streetBrightness: active ? 0.22 : 1,
  };
}
