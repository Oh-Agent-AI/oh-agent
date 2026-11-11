import type { CityViewportWindowDays } from "./projectionRows";

const STORAGE_KEY = "city.window-days";
const OPTIONS: readonly CityViewportWindowDays[] = [7, 30, 90, 366];

/** City 与 Studio 视口共用的数据窗口偏好（同源 localStorage）。否则两边可能用不同窗口装出不同布局。 */
export function readCityWindowDays(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): CityViewportWindowDays {
  const days = Number(storage?.getItem(STORAGE_KEY));
  return OPTIONS.includes(days as CityViewportWindowDays) ? days as CityViewportWindowDays : 366;
}

export function writeCityWindowDays(days: CityViewportWindowDays, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try { storage?.setItem(STORAGE_KEY, String(days)); } catch { /* 无存储：本次窗口仅临时生效 */ }
}
