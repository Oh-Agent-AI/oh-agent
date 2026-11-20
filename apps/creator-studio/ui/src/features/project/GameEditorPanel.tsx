import type { Dispatch, SetStateAction } from "react";
import type { Project } from "../../contracts/creatorStudio";

type PreviewKind = "game" | "scene" | "mount" | "skin";

export function GameEditorPanel(props: Readonly<{
  project: Project | null;
  busy: boolean;
  text: string;
  sceneText: string;
  entryAnchorId: string;
  bindingsText: string;
  skinId: string;
  previewId: string | null;
  previewKind: PreviewKind | null;
  hasUncommittedProjectEdits: boolean;
  visualSlot: "points" | "targets" | null;
  slotMinimum: number;
  setText: Dispatch<SetStateAction<string>>;
  setSceneText: Dispatch<SetStateAction<string>>;
  setEntryAnchorId: Dispatch<SetStateAction<string>>;
  setBindingsText: Dispatch<SetStateAction<string>>;
  setSkinId: Dispatch<SetStateAction<string>>;
  setPreviewId: Dispatch<SetStateAction<string | null>>;
  setPreviewKind: Dispatch<SetStateAction<PreviewKind | null>>;
  onPreviewGame: () => void;
  onPreviewScene: () => void;
  onImportModel: () => void;
  onPreviewMount: () => void;
  onPreviewSkin: (skinId: string) => void;
  onCommit: () => void;
  onOpenProject: () => void;
  onMessage: (message: string) => void;
}>) {
  const {
    project, busy, text, sceneText, entryAnchorId, bindingsText, skinId, previewId, previewKind, hasUncommittedProjectEdits,
    visualSlot, slotMinimum, setText, setSceneText, setEntryAnchorId, setBindingsText, setSkinId, setPreviewId, setPreviewKind,
    onPreviewGame, onPreviewScene, onImportModel, onPreviewMount, onPreviewSkin, onCommit, onOpenProject, onMessage,
  } = props;
  return <section className="editor">
    <div className="section-title">{project ? "玩法与场地" : "选择一个项目"}</div>
    {project ? <>
      <p className="muted">先设置玩法场地，再校验并保存。需要修改规则时可打开高级编辑。</p>
      <details className="advanced-editor"><summary>高级：编辑玩法规则 JSON</summary>
      <textarea aria-label="Mini-game JSON" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
      <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewGame}>校验规则</button><button disabled={busy || !previewId || previewKind !== "game"} onClick={onCommit}>保存规则</button></div>
      </details>
      <details className="scene-editor" open>
        <summary>场地与场景设置</summary>
          <p className="muted">挂载绑定到项目创建时由 City 道路适配器捕获的布局版本。快照只含稳定锚点 ID，不携带几何；世界版本变化后试玩会拒绝启动。</p>
        <details className="advanced-editor"><summary>高级：编辑场景 JSON 和模型</summary><textarea aria-label="Scene draft JSON" spellCheck={false} value={sceneText} disabled={busy} onChange={event => { setSceneText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
        <section className="composition">
          <div className="section-title">模型资源</div>
          <p className="muted">GLB 文件通过桌面原生选择器导入并存入本机项目目录。文件路径和二进制内容不会传给 Agent/MCP。已发布版本可在 City 试玩中渲染受限的静态模型；模型实例与显式碰撞代理分别配置。</p>
          <div className="actions"><button className="secondary" disabled={busy || hasUncommittedProjectEdits} onClick={onImportModel}>从本机导入 GLB 并放入场景</button></div>
          {project.assets?.entries.map(asset => <code key={asset.assetId}>{asset.assetId} · {Math.ceil(asset.byteLength / 1024)} KiB · {asset.boundsMeters ? `${asset.boundsMeters.x.toFixed(1)}×${asset.boundsMeters.y.toFixed(1)}×${asset.boundsMeters.z.toFixed(1)} m` : "尺寸未知"}</code>)}
        </section>
        <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewScene}>校验场景并预览</button><button disabled={busy || !previewId || previewKind !== "scene"} onClick={onCommit}>保存场景</button></div></details>
        <section className="composition">
          <div className="section-title">玩法场地</div><p className="muted">选择入口与玩法目标，再校验并保存场地。</p>
          <div className="anchor-catalog"><span className="muted">可用 City 锚点</span>{project.cityLayout?.layout.anchors.map(anchor => <code key={anchor.id}>{anchor.id} · {anchor.kind}</code>)}</div>
          <label>入口锚点<select value={entryAnchorId} disabled={busy || !project.cityLayout} onChange={event => { setEntryAnchorId(event.target.value); setPreviewId(null); }}>{project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "spawn" && anchor.capabilities.includes("drive")).map(anchor => <option key={anchor.id} value={anchor.id}>{anchor.id}</option>)}</select></label>
          {visualSlot && <fieldset className="anchor-picker"><legend>{visualSlot === "points" ? "检查点" : "收集目标"}</legend><p className="muted">按点击顺序添加；再次点击可移除。{slotMinimum > 0 ? ` 此玩法至少需要 ${slotMinimum} 个。` : ""}</p>{slotMinimum > (project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "zone" && anchor.capabilities.includes("drive")).length ?? 0) && <p className="anchor-warning">当前布局可用目标不足，请返回 City 调整道路布局后重新创建项目。</p>}{project.cityLayout?.layout.anchors.filter(anchor => anchor.kind === "zone" && anchor.capabilities.includes("drive")).map(anchor => {
            let selected: string[] = []; try { const parsed = JSON.parse(bindingsText); if (Array.isArray(parsed[visualSlot])) selected = parsed[visualSlot]; } catch { /* 保留无效的高级输入 */ }
            const order = selected.indexOf(anchor.id);
            return <button type="button" className={`anchor-option ${order >= 0 ? "selected" : ""}`} aria-pressed={order >= 0} key={anchor.id} disabled={busy} onClick={() => { try { const parsed = JSON.parse(bindingsText); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return; const points = Array.isArray(parsed[visualSlot]) ? parsed[visualSlot].filter((id: unknown) => typeof id === "string") : []; setBindingsText(JSON.stringify({ ...parsed, [visualSlot]: order >= 0 ? points.filter((id: string) => id !== anchor.id) : [...points, anchor.id] }, null, 2)); setPreviewId(null); setPreviewKind(null); } catch { onMessage("请先修正高级绑定中的 JSON 格式。"); } }}><span>{order >= 0 ? `${order + 1}` : "+"}</span>{anchor.id}</button>;
          })}</fieldset>}
          <details className="advanced-editor"><summary>高级：编辑槽位绑定 JSON</summary><label>槽位绑定 JSON<textarea className="bindings" aria-label="Mount slot bindings JSON" spellCheck={false} value={bindingsText} disabled={busy} onChange={event => { setBindingsText(event.target.value); setPreviewId(null); }} /></label>
          <p className="muted">按游戏 slots 填入上方 City 锚点 ID，例如 {`{"points":["road-checkpoint:a","road-checkpoint:b"]}`}。SDK 与 Rust 都会校验槽位类型、能力和布局版本。</p></details>
          <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewMount}>校验场地</button><button disabled={busy || !previewId || previewKind !== "mount"} onClick={onCommit}>保存场地</button></div>
        </section>
        <section className="composition">
          <div className="section-title">City 视觉皮肤</div>
          <label>官方皮肤<select value={skinId} disabled={busy} onChange={event => { setSkinId(event.target.value); setPreviewId(null); }}><option value="miami-vice">迈阿密霓虹</option><option value="desert-evening">沙漠暮色</option></select></label>
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => onPreviewSkin(skinId)}>预览皮肤选择</button><button disabled={busy || !previewId || previewKind !== "skin"} onClick={onCommit}>保存皮肤</button></div>
        </section>
      <p className="muted">试玩会临时应用发布版本的官方 City 皮肤，结束后恢复你的 City 外观与偏好。</p>
      </details>
    </> : <div className="empty inspector-empty"><p>从项目列表或顶部选择器打开项目，开始编辑玩法。</p><button onClick={onOpenProject}>创建项目</button></div>}
  </section>;
}
