import { remoteCapability } from "./remoteCapability";

export type SequentialLink = Readonly<{
  ws: string;
  matchId: string;
  access: string;
  device: string;
  token: string;
}>;

/** Parse the v1.5 handoff link without trusting any field that is not part of the v4 contract. */
export function parseSequentialLink(link: string): SequentialLink | null {
  let url: URL;
  try { url = typeof location === "undefined" ? new URL(link) : new URL(link, location.href); } catch { return null; }
  const params = url.searchParams;
  if (remoteCapability(params) !== "mecha:v4") return null;
  const ws = params.get("ws") ?? "", matchId = params.get("match") ?? "", token = url.hash.slice(1);
  if (!ws || !matchId || !token) return null;
  if (!/^wss?:\/\//.test(ws)) return null;
  return { ws, matchId, access: params.get("access") ?? "", device: params.get("device") ?? "", token };
}
