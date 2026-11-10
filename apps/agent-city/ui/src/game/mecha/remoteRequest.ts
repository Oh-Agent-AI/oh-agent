import { pluginRequest } from "../../remote/pluginRequest";

export type RemoteMechaStatus = "idle" | "starting" | "active" | "stopping" | "unknown";
/** Shared host bridge for handoff control calls; no game state crosses this function. */
export const remoteRequest = pluginRequest;
