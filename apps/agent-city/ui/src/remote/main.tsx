import ReactDOM from "react-dom/client";
import { RemoteApp } from "./RemoteApp";
import { startRemoteSessionHost } from "./RemoteSessionHost";

if (new URLSearchParams(location.search).get("sessionHost") === "1") {
  startRemoteSessionHost();
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(<RemoteApp />);
}
