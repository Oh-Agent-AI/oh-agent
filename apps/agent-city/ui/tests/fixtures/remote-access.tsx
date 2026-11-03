// Synthetic hook harness; requests never leave the browser.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useRemoteAccess } from "../../src/remote/remoteAccess";

sessionStorage.setItem("mecha-guest:m1", JSON.stringify({ deviceId: "v1-device", token: "v1-token", playerId: "guest" }));
sessionStorage.setItem("mecha-guest:mecha:v2:m1", JSON.stringify({ deviceId: "v2-device", token: "v2-token", playerId: "guest" }));
const requests: Array<{ authorization: string; body: unknown }> = [];
const pending: Array<(value: Response) => void> = [];
window.fetch = async (_url, init) => {
  const authorization = (init?.headers as Record<string, string>).Authorization;
  requests.push({ authorization, body: JSON.parse(String(init?.body)) });
  if (authorization === "Bearer v1-token") return new Response(JSON.stringify({ ticket: "v1-ticket" }), { status: 200 });
  return new Promise<Response>(resolve => pending.push(resolve));
};
let change = (_query: string) => {};
function Harness() {
  const [query, setQuery] = useState("match=m1&room=r1&invite=i1");
  change = setQuery;
  const access = useRemoteAccess(new URLSearchParams(query));
  const capability = access.client ? (access.client as unknown as { capability: string }).capability : null;
  return <output data-testid="access">{JSON.stringify({ status: access.status, error: access.error, capability, playerId: access.playerId })}</output>;
}
Object.assign(window, { accessFixture: { change: (query: string) => change(query), requests, pending,
  resolve: () => pending.shift()?.(new Response(JSON.stringify({ ticket: "v2-ticket" }), { status: 200 })) } });
createRoot(document.getElementById("root")!).render(<Harness />);
