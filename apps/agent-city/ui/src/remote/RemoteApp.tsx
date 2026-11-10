import { Suspense } from "react";
import { resolveRemoteApp } from "./remoteAppRegistry";
import "./remote.css";

export { remoteDraftProjection } from "./remoteDraftProjection";

export function RemoteApp() {
  const params = new URLSearchParams(location.search);
  const app = resolveRemoteApp(params, import.meta.env.DEV);
  if (app) { const Component = app.component; return <Suspense fallback={<main className="remote-gate">正在载入访客城市…</main>}><Component params={params} /></Suspense>; }
  return <main className="mecha-remote" style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
    <h1 style={{ fontSize: 18 }}>旧版远程链接已退役</h1>
    <p>机甲战棋 1.5 只支持 v1.5 手机续玩。请在桌面端重新生成手机链接。</p>
  </main>;
}
