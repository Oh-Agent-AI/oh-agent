import { executePlanningWorkerJob } from "./planningWorkerJob";
import type { PlanningWorkerResponse } from "./planningProtocol";
const channel = globalThis as unknown as { onmessage: (event: { data: unknown }) => void; postMessage: (response: PlanningWorkerResponse) => void };
channel.onmessage = event => { channel.postMessage(executePlanningWorkerJob(event.data, progress => channel.postMessage(progress))); };
