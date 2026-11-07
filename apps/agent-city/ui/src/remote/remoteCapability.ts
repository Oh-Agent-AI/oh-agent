/** Links without a capability are legacy v1 links; unknown or ambiguous values fail closed. */
export type MechaRemoteCapability = "mecha:v1" | "mecha:v2" | "mecha:v3" | "mecha:v4";

export function remoteCapability(params: URLSearchParams): MechaRemoteCapability | null {
  const values = params.getAll("capability");
  if (values.length === 0) return "mecha:v1";
  if (values.length !== 1) return null;
  return values[0] === "mecha:v1" || values[0] === "mecha:v2" || values[0] === "mecha:v3" || values[0] === "mecha:v4" ? values[0] : null;
}

/** Keep legacy storage keys intact, but isolate deployment-capable credentials. */
export function remoteStorageKey(kind: string, id: string, capability: MechaRemoteCapability): string {
  return capability === "mecha:v1" ? `${kind}:${id}` : `${kind}:${capability}:${id}`;
}
