import { buildCityModel } from "../cityModel";

/** Shared input for a scoped Creator city in both Studio and playtest. */
export function buildIndependentCityModel() {
  return buildCityModel({ harnessNames: {}, rows: [], findings: [], windowStartMs: 0, windowEndMs: 1,
    windowLabel: "独立空城", totalSessions: 0, truncated: false, generatedAt: 0 });
}
