import { RemoteSequentialApp } from "./RemoteSequentialApp";
import { remoteCapability } from "./remoteCapability";
import { remoteRoute } from "./remoteRoute";
import "./remote.css";

export { remoteDraftProjection } from "./remoteDraftProjection";

export function RemoteApp() {
  const params = new URLSearchParams(location.search);
  if (remoteRoute(remoteCapability(params)) === "sequential") return <RemoteSequentialApp params={params} />;
  return <main className="mecha-remote" style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
    <h1 style={{ fontSize: 18 }}>旧版远程链接已退役</h1>
    <p>机甲战棋 1.5 只支持 v1.5 手机续玩。请在桌面端重新生成手机链接。</p>
  </main>;
}
