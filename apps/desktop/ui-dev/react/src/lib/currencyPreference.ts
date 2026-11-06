export type EditableCurrency = "CNY" | "USD";

/** Suggests a currency for a new form only. It never converts or relabels stored money. */
export function suggestedInputCurrency(systemLocale = Intl.DateTimeFormat().resolvedOptions().locale): EditableCurrency {
  try {
    return new Intl.Locale(systemLocale).region?.toUpperCase() === "US" ? "USD" : "CNY";
  } catch {
    return "CNY";
  }
}

export function isEditableCurrency(currency: string | null): currency is EditableCurrency {
  return currency === "CNY" || currency === "USD";
}

/** Exact decimal input for supported two-decimal currencies; no IEEE-754 rounding. */
export function minorToEditableInput(minor: number): string | null {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  const cents = BigInt(minor);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
