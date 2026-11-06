/** Only stable, explicitly public codes may cross the UI serving face. */
const publicCodes = new Set([
  "plugin_assets_missing", "plugin_unknown", "slot_unavailable",
  "plugin_bounds_invalid", "plugin_instance_mismatch", "plugin_instance_unavailable",
  "plugin_window_unavailable", "plugin_attachment_failed", "plugin_layout_failed",
  "plugin_create_failed", "plugin_browser_host_missing",
  "plugin_instance_conflict", "plugin_parent_unavailable", "plugin_webview_create_failed",
]);
const aliases: Record<string, string> = { invalid_bounds: "plugin_bounds_invalid", stale_instance: "plugin_instance_mismatch" };

export function pluginCreationCode(reason: unknown): string {
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
  if (text === "Unsupported browser mock command: plugin_open") return "plugin_browser_host_missing";
  if (Object.hasOwn(aliases, text)) return aliases[text];
  return publicCodes.has(text) ? text : "plugin_create_failed";
}

export function pluginCreationHelp(code: string, english: boolean): string {
  if (code === "plugin_browser_host_missing") return english
    ? "The browser plugin adapter is missing. Restart the development server with the current configuration, then reload this page."
    : "浏览器插件适配器未加载。请使用当前配置重启开发服务，再刷新页面。";
  if (code === "plugin_assets_missing") return english
    ? "Plugin assets are missing. Build the plugins and rebuild the app or browser preview."
    : "插件构建资源缺失。请构建插件，再重新构建应用或浏览器预览。";
  if (code === "plugin_unknown") return english
    ? "The plugin is not registered. Check that the host and plugin registry are from the same build."
    : "插件未注册。请检查宿主与插件注册表是否来自同一次构建。";
  if (code === "plugin_instance_conflict") return english
    ? "A WebView with this instance label already exists. Retry to let the host replace the stale instance."
    : "同一实例的 WebView 已存在。请重试，让宿主清理并重建实例。";
  if (code === "plugin_parent_unavailable") return english
    ? "The host window is unavailable. Return to the workbench and retry."
    : "宿主窗口不可用。请返回工作台后重试。";
  if (code === "plugin_webview_create_failed") return english
    ? "The native WebView could not be created. Check local host logs for the platform error details."
    : "原生 WebView 创建失败。请查看本地宿主日志中的平台错误详情。";
  if (["slot_unavailable", "plugin_bounds_invalid", "plugin_layout_failed"].includes(code)) return english
    ? "The plugin display area is unavailable. Retry after the window layout is ready."
    : "插件显示区域不可用。请等待窗口布局就绪后重试。";
  return english ? "Retry this tab. If the problem persists, check the local host logs; Overview remains available."
    : "请重试此标签页；若持续失败，请检查本地宿主日志。Overview 仍可使用。";
}
