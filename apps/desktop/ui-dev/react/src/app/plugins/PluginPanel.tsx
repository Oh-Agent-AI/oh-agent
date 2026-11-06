import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { message, useLanguage } from "../../lib/i18n";

type PluginPanelProps = { name: string; load: () => Promise<{ default: ComponentType }> };

class PluginErrorBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("[workbench-plugin] plugin failure", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Keep plugin loading/render/effect failures inside its tab, with a local retry. */
export function PluginPanel({ name, load }: PluginPanelProps) {
  const language = useLanguage();
  const [attempt, setAttempt] = useState(0);
  const Plugin = useMemo(() => lazy(load), [load, attempt]);
  return <div className="plugin-panel">
    <PluginErrorBoundary key={attempt} fallback={<section className="plugin-fallback empty-state" role="alert">
      <h2>{message("plugin.failedTitle", language, { name })}</h2>
      <p>{message("plugin.failedHelp", language)}</p>
      <button className="button button-secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>{message("plugin.retry", language)}</button>
    </section>}>
      <Suspense fallback={<p className="plugin-fallback" role="status">{message("plugin.loading", language, { name })}</p>}>
        <Plugin />
      </Suspense>
    </PluginErrorBoundary>
  </div>;
}
