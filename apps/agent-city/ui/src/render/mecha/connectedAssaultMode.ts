export function useConnectedAssault(isDev: boolean, search: string): boolean {
  if (!isDev) return true;
  const params = new URLSearchParams(search);
  return params.get("assaultConnectedPreview") === "1" || !["assaultTrial", "assaultGaitPreview", "assaultLiftPreview"].some((key) => params.get(key) === "1");
}
