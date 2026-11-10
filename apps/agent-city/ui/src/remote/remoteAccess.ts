import { useEffect, useMemo, useRef, useState } from "react";
import { RemoteMatchClient } from "../game/mecha/client/RemoteMatchClient";
import { remoteCapability, remoteStorageKey, type MechaRemoteCapability } from "./remoteCapability";

type Grant = { deviceId: string; token: string; playerId: "guest" };
const grantKey = (matchId: string, capability: MechaRemoteCapability) => remoteStorageKey("mecha-guest", matchId, capability);
const guestJoins = new Map<string, Promise<Grant>>();

export function useRemoteAccess(params: URLSearchParams): { client: RemoteMatchClient | null; status: string; error: string } {
  const requestedCapability = remoteCapability(params);
  const capability: MechaRemoteCapability | null = requestedCapability === "mecha:v4" ? requestedCapability : null;
  const matchId = params.get("match") ?? "";
  const roomId = params.get("room") ?? "";
  const inviteId = params.get("invite") ?? "";
  const ownerUrl = params.get("ws") ?? "";
  const accessKey = capability ? remoteStorageKey("mecha-access", matchId, capability) : "";
  let token = capability ? location.hash.slice(1) : "";
  if (capability && ownerUrl) {
    try {
      token ||= sessionStorage.getItem(accessKey) ?? "";
      if (token) sessionStorage.setItem(accessKey, token);
    } catch { /* A missing credential fails connection; the journal separately blocks sending. */ }
  }
  const endpoint = params.get("access") ?? (roomId ? `${location.origin}/v1/rooms/${roomId}/access` : "");
  const deviceId = params.get("device") ?? "";
  // Do not carry a paired client or grant across a link/capability change.
  const identity = JSON.stringify([capability, matchId, roomId, inviteId, ownerUrl, endpoint, deviceId, token]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const readGrant = (): Grant | null => {
    try {
      const value = JSON.parse(capability ? sessionStorage.getItem(grantKey(matchId, capability)) ?? "null" : "null") as Partial<Grant> | null;
      return value?.deviceId && value.token && value.playerId === "guest" ? value as Grant : null;
    } catch { return null; }
  };
  const [grant, setGrant] = useState<Grant | null>(readGrant);
  const [guestClient, setGuestClient] = useState<RemoteMatchClient | null>(null);
  const [status, setStatus] = useState(capability ? (ownerUrl ? "ready" : "joining") : "failed");
  const [error, setError] = useState(capability ? "" : "unsupported_capability");
  const [stateIdentity, setStateIdentity] = useState(identity);
  if (stateIdentity !== identity) {
    // React immediately retries this render before committing any stale client.
    setStateIdentity(identity); setGrant(readGrant()); setGuestClient(null);
    setStatus(capability ? (ownerUrl ? "ready" : "joining") : "failed");
    setError(capability ? "" : "unsupported_capability");
  }

  const ownerClient = useMemo(() => {
    if (!capability || !ownerUrl || !matchId) return null;
    return new RemoteMatchClient({
      url: ownerUrl, capability,
      ...(endpoint && deviceId && token ? { reconnect: { url: endpoint, deviceId, token } } : {}),
    });
  }, [ownerUrl, matchId, endpoint, token, capability, deviceId]);

  useEffect(() => {
    if (!capability || ownerClient || grant || !matchId || !roomId || !inviteId || !token) return;
    let alive = true;
    const key = `${capability}:${roomId}:${inviteId}`;
    const deviceKey = `mecha-device:${key}`;
    let deviceSecret: string | null;
    try {
      deviceSecret = sessionStorage.getItem(deviceKey);
      if (!deviceSecret) {
        deviceSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
        sessionStorage.setItem(deviceKey, deviceSecret);
      }
    } catch {
      setError("storage_unavailable"); setStatus("failed"); return;
    }
    const credential = deviceSecret;
    let joining = guestJoins.get(key);
    if (!joining) {
      joining = fetch(`${location.origin}/v1/rooms/${roomId}/join`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: matchId, capability, inviteId, deviceSecret: credential }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("invite_unavailable");
        const value = await response.json() as { deviceId?: unknown; playerId?: unknown };
        if (typeof value.deviceId !== "string" || value.playerId !== "guest") throw new Error("invite_unavailable");
        return { deviceId: value.deviceId, token: credential, playerId: "guest" as const };
      });
      guestJoins.set(key, joining);
    }
    void joining.then((next) => {
      if (!alive || currentIdentity.current !== identity) return;
      sessionStorage.setItem(grantKey(matchId, capability), JSON.stringify(next));
      setGrant(next); setStatus("waiting");
    }).catch(() => {
      guestJoins.delete(key);
      if (alive && currentIdentity.current === identity) { setError("invite_unavailable"); setStatus("failed"); }
    });
    return () => { alive = false; };
  }, [ownerClient, grant, matchId, roomId, inviteId, token, capability, identity]);

  useEffect(() => {
    if (!capability || ownerClient || !grant || !endpoint) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const pair = async () => {
      try {
        const response = await fetch(endpoint, {
          method: "POST", headers: { Authorization: `Bearer ${grant.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pair", deviceId: grant.deviceId }), cache: "no-store",
        });
        if (!response.ok) throw new Error("approval_pending");
        const value = await response.json() as { ticket?: unknown };
        if (!alive || currentIdentity.current !== identity) return;
        if (typeof value.ticket !== "string" || !value.ticket) throw new Error("approval_pending");
        const url = new URL(endpoint);
        url.pathname = url.pathname.replace(/\/access$/, "/ws");
        url.search = "";
        url.searchParams.set("ticket", value.ticket);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        setGuestClient(new RemoteMatchClient({ url: url.toString(), capability, reconnect: { url: endpoint, deviceId: grant.deviceId, token: grant.token } }));
        setStatus("ready");
      } catch {
        if (!alive || currentIdentity.current !== identity) return;
        attempts += 1;
        if (attempts >= 240) { setStatus("failed"); setError("approval_expired"); return; }
        timer = setTimeout(pair, 2500);
      }
    };
    void pair();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [grant, endpoint, capability, ownerClient, identity]);

  return { client: capability ? ownerClient ?? guestClient : null, status: capability ? status : "failed", error: capability ? error : "unsupported_capability" };
}
