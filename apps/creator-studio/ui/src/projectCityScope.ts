import { validateCityInstance, type CityInstanceV1 } from "@agent-vitals/city-sdk";

/** Never substitute the active City or a newer draft for a pinned project. */
export function resolveProjectCity(raw: unknown, binding: { cityId: string; cityRevision?: number; seed?: number }): CityInstanceV1 | null {
  const checked = validateCityInstance(raw);
  if (!checked.ok || checked.value.cityId !== binding.cityId || checked.value.revision !== binding.cityRevision || checked.value.seed !== binding.seed) return null;
  return checked.value;
}
