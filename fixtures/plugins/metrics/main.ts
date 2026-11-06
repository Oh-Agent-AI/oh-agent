// Test-only second consumer. Built from the SAME public UI SDK as City.
import { connect, observeHealth, publish, publishToolbar, invokeHost } from "../../../packages/agent-vitals-app-sdk/src/ui-host";
let count = 0;
const render = () => { document.body.textContent = `Metrics count: ${count}`; };
render();
observeHealth();
connect((command) => {
  if (command.commandId === "metrics.increment") { count++; render(); }
  else if (command.commandId === "metrics.fail") void publish("runtime.error");
  else throw new Error("unknown_metrics_command");
});
publishToolbar([
  { id: "increment", commandId: "metrics.increment", label: "Increment", kind: "button", enabled: true },
  { id: "fail", commandId: "metrics.fail", label: "Fail fixture", kind: "button", enabled: true },
]);
void invokeHost("plugin_request", { request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId: "metrics-data", method: "metrics.read", payload: { countOnly: true } } });
