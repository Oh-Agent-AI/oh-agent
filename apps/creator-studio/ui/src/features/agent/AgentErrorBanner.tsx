/**
 * 会话级错误横幅（T3 ThreadErrorBanner 模式）：composer 上方可关闭的警示条，
 * 展示用户可读文案与（不同的）原始错误码，可携带一个主行动作。
 */
export function AgentErrorBanner({ message, code, action, onDismiss }: Readonly<{
  message: string;
  code: string;
  action?: Readonly<{ label: string; onAction: () => void }>;
  onDismiss: () => void;
}>) {
  return <div className="agent-error-banner" role="alert">
    <div className="agent-error-banner-body">
      <p>{message}</p>
      {code !== message && <code className="muted">{code}</code>}
    </div>
    <div className="actions">
      {action && <button type="button" className="secondary" onClick={action.onAction}>{action.label}</button>}
      <button type="button" className="secondary" onClick={onDismiss}>知道了</button>
    </div>
  </div>;
}
