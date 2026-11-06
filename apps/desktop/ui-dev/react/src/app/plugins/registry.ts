import registry from "../../../../../plugins.json";

export type PluginDefinition = { id: string; name: string; entry: string; commandNamespace: string };
// Supplied by the same build-time registry in native and browser hosts.
declare global { interface Window { __AV_PLUGIN_REGISTRY__?: { version: number; plugins: PluginDefinition[] }; } }
export const plugins: readonly PluginDefinition[] = typeof window !== "undefined" && window.__AV_PLUGIN_REGISTRY__
  ? window.__AV_PLUGIN_REGISTRY__.plugins : registry.plugins;
