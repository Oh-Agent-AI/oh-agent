import { useEffect, useMemo, useState } from "react";
import { RemoteMatchClient } from "../game/mecha/client/RemoteMatchClient";
import type { RemoteBattleState } from "../game/mecha/presentation/BattleScenePort";

type Grant = { deviceId: string; token: string; playerId: "guest" };
const grantKey = (matchId: string) => `mecha-guest:${matchId}`;
const guestJoins = new Map<string, Promise<Grant>>();

export function useRemoteAccess(params: URLSearchParams): { client: RemoteMatchClient<RemoteBattleState> | null; playerId: string; status: string; error: string } {
  const matchId = params.get("match") ?? "";
  const roomId = params.get("room") ?? "";
  const inviteId = params.get("invite") ?? "";
  const ownerUrl = params.get("ws") ?? "";
  const token = location.hash.slice(1) || (ownerUrl ? sessionStorage.getItem(`mecha-access:${matchId}`) ?? "" : "");
  if (ownerUrl && token) sessionStorage.setItem(`mecha-access:${matchId}`, token);
  const endpoint = params.get("access") ?? (roomId ? `${location.origin}/v1/rooms/${roomId}/access` : "");
  const [grant, setGrant] = useState<Grant | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(grantKey(matchId)) ?? "null") as Partial<Grant> | null;
      return value?.deviceId && value.token && value.playerId === "guest" ? value as Grant : null;
    } catch { return null; }
  });
  const [guestClient, setGuestClient] = useState<RemoteMatchClient<RemoteBattleState> | null>(null);
  const [status, setStatus] = useState(ownerUrl ? "ready" : "joining");
  const [error, setError] = useState("");

  const ownerClient = useMemo(() => {
    const deviceId = params.get("device") ?? "";
    if (!ownerUrl || !matchId) return null;
    return new RemoteMatchClient<RemoteBattleState>({
      url: ownerUrl, playerId: params.get("player") ?? "owner",
      ...(endpoint && deviceId && token ? { reconnect: { url: endpoint, deviceId, token } } : {}),
    });
  }, [ownerUrl, matchId, endpoint, token]);

  useEffect(() => {
    if (ownerClient || grant || !matchId || !roomId || !inviteId || !token) return;
    let alive = true;
    const key = `${roomId}:${inviteId}`;
    const deviceKey = `mecha-device:${key}`;
    let deviceSecret = sessionStorage.getItem(deviceKey);
    if (!deviceSecret) {
      deviceSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(deviceKey, deviceSecret);
    }
    const credential = deviceSecret;
    let joining = guestJoins.get(key);
    if (!joining) {
      joining = fetch(`${location.origin}/v1/rooms/${roomId}/join`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: "app-remote:v1", appId: "city", sessionId: matchId, capability: "mecha:v1", inviteId, deviceSecret: credential }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("invite_unavailable");
        const value = await response.json() as { deviceId?: unknown; playerId?: unknown };
        if (typeof value.deviceId !== "string" || value.playerId !== "guest") throw new Error("invite_unavailable");
        return { deviceId: value.deviceId, token: credential, playerId: "guest" as const };
      });
      guestJoins.set(key, joining);
    }
    void joining.then((next) => {
      if (!alive) return;
      sessionStorage.setItem(grantKey(matchId), JSON.stringify(next));
      setGrant(next); setStatus("waiting");
    }).catch(() => {
      guestJoins.delete(key);
      if (alive) { setError("invite_unavailable"); setStatus("failed"); }
    });
    return () => { alive = false; };
  }, [ownerClient, grant, matchId, roomId, inviteId, token]);

  useEffect(() => {
    if (!grant || !endpoint) return;
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
        if (!alive) return;
        if (typeof value.ticket !== "string" || !value.ticket) throw new Error("approval_pending");
        const url = new URL(endpoint);
        url.pathname = url.pathname.replace(/\/access$/, "/ws");
        url.search = "";
        url.searchParams.set("ticket", value.ticket);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        setGuestClient(new RemoteMatchClient<RemoteBattleState>({ url: url.toString(), playerId: "guest", reconnect: { url: endpoint, deviceId: grant.deviceId, token: grant.token } }));
        setStatus("ready");
      } catch {
        if (!alive) return;
        attempts += 1;
        if (attempts >= 240) { setStatus("failed"); setError("approval_expired"); return; }
        timer = setTimeout(pair, 2500);
      }
    };
    void pair();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [grant, endpoint]);

  return { client: ownerClient ?? guestClient, playerId: ownerClient ? params.get("player") ?? "owner" : "guest", status, error };
}
