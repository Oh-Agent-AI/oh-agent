import { type ReactNode } from "react";
import type { StudioPanel } from "../../contracts/creatorStudio";

const tools = [
  { id: "project", label: "世界" },
  { id: "play", label: "玩法" },
  { id: "story", label: "剧情" },
] as const;

export function WorkspaceContentDrawer({ open, panel, onSelect, onClose, children }: {
  open: boolean;
  panel: StudioPanel;
  onSelect: (panel: "project" | "play" | "story") => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return <section className="workspace-tool-panel" id="workspace-content" hidden={!open} aria-label="作品内容"
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); }
    }}>
    <header className="workspace-content-header">
      <nav className="workspace-tool-nav" aria-label="编辑工具">
        {tools.map(tool => <button type="button" key={tool.id}
          aria-pressed={panel === tool.id || (tool.id === "play" && panel === "code")}
          onClick={() => onSelect(tool.id)}>{tool.label}</button>)}
      </nav>
      <button type="button" className="secondary" onClick={onClose}>关闭内容</button>
    </header>
    <div className="workspace-content-body">{children}</div>
  </section>;
}
