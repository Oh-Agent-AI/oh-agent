import ReactDOM from "react-dom/client";
import { RemoteApp } from "./RemoteApp";
import { startRemoteHostRuntime } from "./RemoteHostRuntime";
import { REMOTE_HOST_ADAPTERS } from "./remoteHostManifest";

if (new URLSearchParams(location.search).get("sessionHost") === "1") {
  startRemoteHostRuntime(REMOTE_HOST_ADAPTERS);
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(<RemoteApp />);
}
