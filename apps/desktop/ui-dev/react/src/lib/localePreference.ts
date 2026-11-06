export type LanguagePreference = "system" | "en" | "zh-Hans";
export type AppLanguage = "en" | "zh-Hans";

export const languageStorageKey = "agent-vitals.language";

export function languagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(languageStorageKey);
    return stored === "en" || stored === "zh-Hans" ? stored : "system";
  } catch { return "system"; }
}

export function resolvedLanguage(preference = languagePreference(), systemLanguage = typeof navigator === "undefined" ? "en-US" : navigator.language): AppLanguage {
  if (preference !== "system") return preference;
  return systemLanguage.toLowerCase().startsWith("zh") ? "zh-Hans" : "en";
}
