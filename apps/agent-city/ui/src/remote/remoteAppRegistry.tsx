import { lazy, type ComponentType } from "react";
import { RemoteSequentialApp } from "./RemoteSequentialApp";

const DreamCityApp = lazy(() => import("./city/DreamCityApp").then((module) => ({ default: module.DreamCityApp })));

export type RemoteAppContext = { params: URLSearchParams };
export type RemoteAppRegistration = {
  capability: string;
  developmentOnly?: boolean;
  component: ComponentType<RemoteAppContext>;
};

// Applications opt into a versioned capability here. The registry selects a
// UI adapter; it does not grant host permissions or validate remote payloads.
export const REMOTE_APPS: readonly RemoteAppRegistration[] = [
  { capability: "mecha:v4", component: RemoteSequentialApp },
  { capability: "city-dream:v1", component: DreamCityApp },
];

export function resolveRemoteApp(params: URLSearchParams, development: boolean, registrations = REMOTE_APPS): RemoteAppRegistration | null {
  const capabilities = params.getAll("capability");
  if (capabilities.length > 1) return null;
  const capability = capabilities[0] ?? "mecha:v1";
  const matches = registrations.filter(entry => entry.capability === capability && (!entry.developmentOnly || development));
  return matches.length === 1 ? matches[0] : null;
}
