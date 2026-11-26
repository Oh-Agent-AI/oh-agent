import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { Project } from "../../contracts/creatorStudio";
import { mountChoices, mountSlotLabel, readMountBindings } from "./mountEditorModel";

import { VenueMap, type VenueGeometry, type VenueRoad } from "./VenueMap";

type PreviewKind = "game" | "scene" | "mount" | "skin";
export type EditorFocusTarget = PreviewKind;

export function GameEditorPanel(props: Readonly<{
  project: Project | null;
  busy: boolean;
  venueGeometry: VenueGeometry | null;
  venueRoads: readonly VenueRoad[];
  text: string;
  sceneText: string;
  entryAnchorId: string;
  bindingsText: string;
  skinId: string;
  previewId: string | null;
  previewKind: PreviewKind | null;
  hasUncommittedProjectEdits: boolean;
  focusTarget: EditorFocusTarget | null;
  onFocusHandled: () => void;
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
    setText, setSceneText, setEntryAnchorId, setBindingsText, setSkinId, setPreviewId, setPreviewKind,
    focusTarget, onFocusHandled,
    onPreviewGame, onPreviewScene, onImportModel, onPreviewMount, onPreviewSkin, onCommit, onOpenProject, onMessage,
  } = props;
  const layout = project?.cityLayout?.layout;
  const game = project?.game;
  const choices = useMemo(() => mountChoices(layout, game), [layout, game]);
  const bindings = readMountBindings(bindingsText);
  const editor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusTarget) return;
    const target = editor.current?.querySelector<HTMLElement>(`[data-editor-section="${focusTarget}"]`);
    if (target?.tagName === "DETAILS") (target as HTMLDetailsElement).open = true;
    (target ?? editor.current)?.focus();
    onFocusHandled();
  }, [focusTarget, onFocusHandled]);

  return <section className="editor" ref={editor} tabIndex={-1} aria-label="玩法编辑">
    {project ? <>
        <section className="composition workspace-mount" data-editor-section="mount" tabIndex={-1} aria-label="玩法场地">
          <div className="section-title">玩法场地</div>
          <p className="muted">在地图上选择起点和目标，按经过顺序布置，再校验并保存。</p>
          {!props.venueGeometry && <p className="muted">等项目对应的城市场景就绪后，即可在地图上选点。</p>}
          {props.venueGeometry && choices.slots.map(slot => {
            const raw = bindings?.[slot.id];
            const selected = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
            return <fieldset key={slot.id} className="anchor-picker">
              <legend>{mountSlotLabel(slot.id)} · 已选 {selected.length} 个（需 {slot.min}–{slot.max} 个）</legend>
              {slot.anchors.length < slot.min && <p className="anchor-warning">这个场地的可用点位不足，请选择包含所需点位的 City。</p>}
              <VenueMap geometry={props.venueGeometry!} roads={props.venueRoads} entries={choices.entries} targets={slot.anchors}
                entryId={entryAnchorId} orderedIds={selected} disabled={busy}
                onEntry={id => { setEntryAnchorId(id); setPreviewId(null); setPreviewKind(null); }}
                onTarget={id => {
                  if (!bindings) { onMessage("请先修正高级绑定中的 JSON 格式。"); return; }
                  if (!selected.includes(id) && selected.length >= slot.max) { onMessage(`最多选择 ${slot.max} 个，请先移除一个。`); return; }
                  const next = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id];
                  setBindingsText(JSON.stringify({ ...bindings, [slot.id]: next }, null, 2));
                  setPreviewId(null); setPreviewKind(null);
                }} />
            </fieldset>;
          })}
          <details className="advanced-editor"><summary>高级：查看锚点和编辑绑定</summary>
          <label>入口 ID<select value={entryAnchorId} disabled={busy || !choices.entries.length} onChange={event => { setEntryAnchorId(event.target.value); setPreviewId(null); setPreviewKind(null); }}>
            {!choices.entries.some(anchor => anchor.id === entryAnchorId) && <option value={entryAnchorId} disabled>选择入口</option>}
            {choices.entries.map(anchor => <option key={anchor.id} value={anchor.id}>{anchor.id}</option>)}
          </select></label>
          <div className="anchor-catalog"><span className="muted">可用 City 锚点</span>{project.cityLayout?.layout.anchors.map(anchor => <code key={anchor.id}>{anchor.id} · {anchor.kind}</code>)}</div>
          <label>槽位绑定 JSON<textarea className="bindings" aria-label="Mount slot bindings JSON" spellCheck={false} value={bindingsText} disabled={busy} onChange={event => { setBindingsText(event.target.value); setPreviewId(null); }} /></label>
          <p className="muted">按游戏 slots 填入上方 City 锚点 ID，例如 {`{"points":["road-checkpoint:a","road-checkpoint:b"]}`}。SDK 与 Rust 都会校验槽位类型、能力和布局版本。</p></details>
          <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewMount}>校验场地</button><button disabled={busy || !previewId || previewKind !== "mount"} onClick={onCommit}>保存场地</button></div>
        </section>
      <details className="advanced-editor" data-editor-section="game" tabIndex={-1}><summary>高级：编辑玩法规则 JSON</summary>
      <textarea aria-label="Mini-game JSON" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
      <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewGame}>校验规则</button><button disabled={busy || !previewId || previewKind !== "game"} onClick={onCommit}>保存规则</button></div>
      </details>
        <details className="advanced-editor" data-editor-section="scene" tabIndex={-1}><summary>高级：编辑场景 JSON 和模型</summary><textarea aria-label="Scene draft JSON" spellCheck={false} value={sceneText} disabled={busy} onChange={event => { setSceneText(event.target.value); setPreviewId(null); setPreviewKind(null); }} />
        <section className="composition">
          <div className="section-title">模型资源</div>
          <p className="muted">GLB 文件通过桌面原生选择器导入并存入本机项目目录。文件路径和二进制内容不会传给 Agent/MCP。已发布版本可在 City 试玩中渲染受限的静态模型；模型实例与显式碰撞代理分别配置。</p>
          <div className="actions"><button className="secondary" disabled={busy || hasUncommittedProjectEdits} onClick={onImportModel}>从本机导入 GLB 并放入场景</button></div>
          {project.assets?.entries.map(asset => <code key={asset.assetId}>{asset.assetId} · {Math.ceil(asset.byteLength / 1024)} KiB · {asset.boundsMeters ? `${asset.boundsMeters.x.toFixed(1)}×${asset.boundsMeters.y.toFixed(1)}×${asset.boundsMeters.z.toFixed(1)} m` : "尺寸未知"}</code>)}
        </section>
        <div className="actions"><button className="secondary" disabled={busy} onClick={onPreviewScene}>校验场景并预览</button><button disabled={busy || !previewId || previewKind !== "scene"} onClick={onCommit}>保存场景</button></div></details>
        <details className="advanced-editor" data-editor-section="skin" tabIndex={-1}>
          <summary>City 视觉皮肤</summary>
          <label>官方皮肤<select value={skinId} disabled={busy} onChange={event => { setSkinId(event.target.value); setPreviewId(null); }}><option value="miami-vice">迈阿密霓虹</option><option value="desert-evening">沙漠暮色</option></select></label>
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => onPreviewSkin(skinId)}>预览皮肤选择</button><button disabled={busy || !previewId || previewKind !== "skin"} onClick={onCommit}>保存皮肤</button></div>
        </details>
    </> : <div className="empty inspector-empty"><p>从项目列表或顶部选择器打开项目，开始编辑玩法。</p><button onClick={onOpenProject}>创建项目</button></div>}
  </section>;
}
