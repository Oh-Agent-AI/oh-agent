import { useEffect, useRef, useState } from "react";
import { useCityLanguage } from "../i18n";
import { repairText, repairView } from "./repairCopy";
import { isGenericHint, siteLabel, type DrawMode, type RepairTool, type RoadType } from "./controller";
import type { PlanRepairUi } from "./usePlanRepair";

const RULE_LABEL: Record<string, string> = {
  buildingOverRoad: "楼压路", buildingOverlap: "楼重叠", buildingOnSlope: "坡地/不可建", orphanedBlock: "街区无路", patchStale: "补丁失效",
  bridgeheadOblique: "桥头斜接", bridgeheadSteep: "桥头过陡", roadSteep: "陡路",
};
const SEVERITY_LABEL = { error: "错误", warning: "警告", info: "提示" } as const;
const MAX_ISSUE_ROWS = 8;

const TOOLS: Array<{ id: RepairTool; label: string; key: string; icon: string; hint: string }> = [
  { id: "build", icon: "✥", label: "移动", key: "V", hint: "点选任意建筑，再点空地搬过去：会话楼搬到你选的地块，设施、地标、市政用地搬到任意空地" },
  { id: "draw", icon: "✎", label: "画路", key: "R", hint: "点两下画一段路，可连续画" },
  { id: "erase", icon: "⌫", label: "橡皮擦", key: "E", hint: "点击红色高亮的路段擦掉" },
  { id: "restyle", icon: "⇄", label: "改路", key: "T", hint: "选路型后点一条路：整条街改成这个路型" },
  { id: "node", icon: "◎", label: "路口", key: "N", hint: "点一个路口拿起来，再点一下放下：连着的路跟着走" },
  { id: "site", icon: "▣", label: "设施", key: "S", hint: "编辑非会话建筑：公共设施、花园、地标、市政用地、背景楼——搬家或拆除" },
  { id: "drive", icon: "▶", label: "试驾", key: "D", hint: "点一条路或一座桥：车沿它来回各开一遍，告诉你开不开得过去" },
];
const ROAD_TYPES: Array<{ id: RoadType; label: string; hint: string }> = [
  { id: "local", label: "小路", hint: "宽 5，街区内的支路" },
  { id: "secondary", label: "次干道", hint: "宽 8" },
  { id: "main", label: "主干道", hint: "宽 12，城市骨架级" },
  { id: "waterfront", label: "滨海大道", hint: "宽 12，沿路向海一侧铺滨海景观带（步道、矮墙、路灯）" },
  { id: "viaduct", label: "高架", hint: "逐点点击画折线，可跨河跨路，两端自动落地成匝道；回车完成" },
];

const DRAW_MODES: Array<{ id: DrawMode; label: string; hint: string }> = [
  { id: "straight", label: "直线", hint: "点两下画一段直路；从路尽头拐弯自动倒圆，过河自动架桥" },
  { id: "curve", label: "弧线", hint: "点起点、路要经过的点、终点，画一段弧线路；弯的急缓有下限（按路型）" },
];

/**
 * 规划修复面板（开发预览，仅中文）。未进入修复模式时只显示一个始终可见的入口按钮——
 * 曾把入口放在设置弹窗最底部，小窗口里被挤出可视区，用户根本找不到。
 */
export function PlanRepairPanel({ repair }: { repair: PlanRepairUi }) {
  const { state, info, issues } = repair;
  const language = useCityLanguage();
  const en = language === "en";
  const T = (text: string) => repairText(text, language);
  const countLabel = (zh: string) => en ? T(`计数:${zh}`) : zh;
  const keyed = (text: string, key: string) => en ? `${T(text)} (${key})` : `${text}（${key}）`;
  const [confirmReset, setConfirmReset] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (!state.active) setConfirmReset(false); }, [state.active]);
  // 提示气泡（工具提示 + 控制器消息）点击面板以外的任何地方就收起；换工具、或来了针对当前操作的新消息（成功/警告/失败，
  // 以及「已选中…」这类选中后的提示）时重新出现；通用的工具用法提示（点空白会回到它）不会再弹回来。
  const [bubbleHidden, setBubbleHidden] = useState(false);
  const lastMessage = useRef(state.message);
  useEffect(() => { setBubbleHidden(false); }, [state.tool, state.active]);
  useEffect(() => {
    if (state.message === lastMessage.current) return;
    lastMessage.current = state.message;
    if (state.message && !isGenericHint(state.message)) setBubbleHidden(false);
  }, [state.message]);
  useEffect(() => {
    if (!state.active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".city-repair")) return;
      setBubbleHidden(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [state.active]);

  if (!repair.enabled) return null;
  if (!state.active) {
    // 入口已移到顶部导航「更多工具」（CityApp 的 city.repair），未进入修复模式时不在画面上放任何东西。
    return null;
  }

  const counts = info.counts;
  const total = counts ? counts.buildingMoves + counts.roadOps + counts.highwayOps + counts.siteOps + counts.suppressedContext : 0;
  // 恢复生成两段确认（同 reseed 的 4 秒确认模式）：误点一次不会丢掉全部修改。
  const onReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      timer.current = window.setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    window.clearTimeout(timer.current); setConfirmReset(false); repair.reset();
  };
  const preview = state.preview;
  const previewReason = preview && "reason" in preview ? preview.reason : null;
  const previewNote = !previewReason && preview && "warning" in preview ? preview.warning : null;

  const activeTool = TOOLS.find((tool) => tool.id === state.tool);
  const message = bubbleHidden ? null : state.message;
  const tipShown = !bubbleHidden && !!activeTool && !state.message && !previewReason && state.tool !== "draw" && state.tool !== "restyle";
  const hasDetail = !!(state.tool === "draw" || state.tool === "restyle" || info.remap || info.tierChanged || info.staleCount > 0 || message || tipShown
    || previewReason || previewNote || state.buildingId || state.site || state.stranded.length || state.proposal || issues || (counts && total > 0));
  const badge = total === 0 ? "未修改" : `${total} 处`;
  const saveNote = total === 0 ? null : info.saveFailed ? "仅临时" : info.savePending ? "保存中…" : "已保存";
  // 侧栏停靠形态（SimCity 式）：右边缘一条窄工具栏常驻，选项/提示/体检结果按需在它左侧弹出一块小卡片，
  // 不用时只占 58px 宽，不挡画面；容器本身不拦截鼠标，只有栏和卡片可点。
  return repairView(<section className="city-repair" aria-label="规划修复">
    {hasDetail && <div className="city-repair-flyout">
    {tipShown && activeTool && <p className="city-repair-tip"><b>{activeTool.label}</b>{" "}{activeTool.hint}</p>}
    {(state.tool === "draw" || state.tool === "restyle") && <div className="city-repair-group"><span className="city-repair-label">路型</span><div className="city-repair-widths" role="radiogroup" aria-label="路型">
      {ROAD_TYPES.filter((type) => state.tool === "draw" || type.id !== "viaduct").map((type) => <button key={type.id} role="radio" aria-checked={state.roadType === type.id} title={type.hint} className={state.roadType === type.id ? "is-active" : ""} onClick={() => repair.setRoadType(type.id)}>{type.label}</button>)}
    </div></div>}
    {state.tool === "draw" && state.roadType !== "viaduct" && <div className="city-repair-group"><span className="city-repair-label">画法</span><div className="city-repair-widths" role="radiogroup" aria-label="画法">
      {DRAW_MODES.map((mode) => <button key={mode.id} role="radio" aria-checked={state.drawMode === mode.id} title={en ? `${T(mode.hint)} (C toggles)` : `${mode.hint}（C 切换）`} className={state.drawMode === mode.id ? "is-active" : ""} onClick={() => repair.setDrawMode(mode.id)}>{mode.label}</button>)}
    </div></div>}
    {state.tool === "draw" && state.roadType === "viaduct" && state.viaduct.length > 0 && <div className="city-repair-site">
      <span>{`高架已点 ${state.viaduct.length} 个点`}</span>
      <button onClick={repair.finishViaduct} disabled={state.viaduct.length < 2} title="回车">完成</button>
    </div>}
    {info.remap && <div className={`city-repair-banner${info.remap.failed.length ? " city-repair-banner-soft" : " city-repair-banner-ok"}`} role="status">
      <p>{en
        ? `${info.remap.fromTier === info.remap.toTier
          ? "City generation rules were updated and plots and junctions were re-laid out. "
          : `The city grew from tier ${info.remap.fromTier} to tier ${info.remap.toTier} with your session count (scaled ${info.remap.ratio.toFixed(2)}×). `}Moved ${info.remap.remapped} of your edits onto the new map${info.remap.alreadySatisfied.length ? `; ${info.remap.alreadySatisfied.length} more already hold and need no replay` : ""}${info.remap.failed.length ? `; ${info.remap.failed.length} had no matching spot and were removed (the original patch is archived)` : ""}`
        : `${info.remap.fromTier === info.remap.toTier
          ? "城市生成规则更新了，地块和路口重新排过，"
          : `城市随会话数增长从第 ${info.remap.fromTier} 档变到第 ${info.remap.toTier} 档（放大 ${info.remap.ratio.toFixed(2)} 倍），`}已把你的 ${info.remap.remapped} 处修改搬到新地图上${info.remap.alreadySatisfied.length ? `；另有 ${info.remap.alreadySatisfied.length} 处目标状态已满足，无需重放` : ""}${info.remap.failed.length ? `；${info.remap.failed.length} 处没找到对应位置，已移除（原补丁已存档）` : ""}`}</p>
      {info.remap.alreadySatisfied.length > 0 && <ul className="city-repair-remap-failed city-repair-remap-satisfied">{info.remap.alreadySatisfied.slice(0, 5).map((item) => <li key={`${item.kind}:${item.id}`}>{item.detail}</li>)}</ul>}
      {info.remap.failed.length > 0 && <ul className="city-repair-remap-failed">{info.remap.failed.slice(0, 5).map((item) => <li key={`${item.kind}:${item.id}`}>{item.detail}</li>)}</ul>}
      <button onClick={repair.dismissRemap}>知道了</button>
    </div>}
    {info.tierChanged ? <div className="city-repair-banner" role="alert">
      <p>{en
        ? `${info.generatorChanged ? "City generation rules were updated" : "The city grew one tier with your session count"}; plots and junctions were re-laid out — your earlier ${info.staleCount} edit(s) are all stale and not shown on the map.`
        : `${info.generatorChanged ? "城市生成规则更新了" : "城市已随会话数增长扩大了一档"}，地块和路口都重新排过——之前的 ${info.staleCount} 处修改已全部失效，没有显示在地图上。`}</p>
      <button onClick={repair.pruneStale}>清除失效修改</button>
    </div> : info.staleCount > 0 && <div className="city-repair-banner city-repair-banner-soft">
      <p>{en
        ? `${info.staleCount} edit(s) are stale (their object is gone or moved after the city recomputed) and have no effect; use Audit to review them one by one.`
        : `${info.staleCount} 处修改已失效（城市重算后对象不在了或位置变了），它们不起作用；点「体检」可逐条查看。`}</p>
      <button onClick={repair.pruneStale}>清除失效修改</button>
    </div>}
    {message && <p className={`city-repair-msg city-repair-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    {previewReason && <p className="city-repair-reason">不可行：{previewReason}</p>}
    {previewNote && <p className="city-repair-note">注意：{previewNote}</p>}
    {state.buildingId && state.tool === "build" && <p className="city-repair-sel">选中：<code>{state.buildingId}</code></p>}
    {state.tool === "site" && state.site && <div className="city-repair-site">
      <span>选中：<b>{siteLabel(state.site)}</b></span>
      {state.site.level === "free" && <span className="city-repair-turn">
        <button onClick={() => repair.rotateSite(-1)} title="逆时针转 90°（[）">↺</button>
        <button onClick={() => repair.rotateSite(1)} title="顺时针转 90°（]）">↻</button>
      </span>}
      <button onClick={repair.removeSelected} title="拆除选中的设施（Delete）">拆除</button>
    </div>}
    {state.tool === "site" && !state.site && state.preview?.kind === "site" && <p className="city-repair-sel">指向：{state.preview.label}（点击选中）</p>}
    {state.proposal && <div className="city-repair-site">
      <span>{en ? "Fix proposal: red is erased, green is the new bridge" : "修复方案：红色擦掉，绿色画新桥"}</span>
      <button onClick={repair.acceptProposal} title="一步写入，撤销可恢复；写入后自动试驾新桥">采用</button>
      <button onClick={repair.cancelProposal} title="放弃这个方案（Esc）">取消</button>
    </div>}
    {state.stranded.length > 0 && <div className="city-repair-site">
      <span>{en ? `${state.stranded.length} dead-end access segment(s) left behind` : `原址留下 ${state.stranded.length} 段断头接入路`}</span>
      <button onClick={repair.eraseStranded} title="一次擦掉，撤销可恢复">擦掉</button>
    </div>}
    {(info.staleCount > 0 || (counts && total > 0)) && <p className="city-repair-status">
      {counts && total > 0 && `${[counts.buildingMoves ? `${countLabel("移楼")} ${counts.buildingMoves}` : "", counts.roadAdds ? `${countLabel("画路")} ${counts.roadAdds}` : "", counts.roadDrops ? `${countLabel("擦路")} ${counts.roadDrops}` : "", counts.highwayOps ? `${countLabel("高架")} ${counts.highwayOps}` : "", counts.roadOps - counts.roadAdds - counts.roadDrops > 0 ? `${countLabel("改路口")} ${counts.roadOps - counts.roadAdds - counts.roadDrops}` : "", counts.siteOps ? `${countLabel("改设施")} ${counts.siteOps}` : ""].filter(Boolean).join(" · ")}`}
      {info.staleCount > 0 && <span className="city-repair-stale">{` · ${info.staleCount} ${T("条已失效")}`}</span>}
    </p>}
    {issues && <div className="city-repair-audit">
      {issues.length === 0 ? <p className="city-repair-ok">体检通过：没有发现布局或道路问题</p> : <>
        <p>{`${issues.length} 个问题${issues.length > MAX_ISSUE_ROWS ? `（显示前 ${MAX_ISSUE_ROWS} 个）` : ""}`}</p>
        <ul>{issues.slice(0, MAX_ISSUE_ROWS).map((issue) => <li key={issue.id} className={`city-repair-${issue.severity}`}>
          <span><b>{SEVERITY_LABEL[issue.severity]}</b>{issue.origin && <i className={`city-repair-origin city-repair-origin-${issue.origin}`}>{issue.origin === "edit" ? "你的修改造成" : "生成时就有"}</i>}{" "}{`${T(RULE_LABEL[issue.rule] ?? issue.rule)}${en ? ": " : "："}${T(issue.detail)}`}</span>
          {issue.at && <button onClick={() => repair.locate(issue)}>定位</button>}
          {(issue.rule === "bridgeheadOblique" || issue.rule === "bridgeheadSteep") && <button onClick={() => repair.proposeFix(issue)} title="擦掉整座桥和岸边残路，在附近画一座直桥——先预览，点「采用」才写入">修复方案</button>}
        </li>)}</ul>
      </>}
    </div>}
    </div>}
    <div className="city-repair-rail" role="toolbar" aria-label="修复工具">
      <span className="city-repair-badge" title={info.saveFailed ? "本次修改仅临时生效（存档失败）" : total === 0 ? "尚无修改" : "修改会自动保存在本机，关闭或重启后仍在"}>{badge}{saveNote && <small className={info.saveFailed ? "is-warn" : ""}>{saveNote}</small>}</span>
      {TOOLS.map((tool) => <button key={tool.id} className={state.tool === tool.id ? "is-active" : ""} aria-pressed={state.tool === tool.id} title={keyed(tool.hint, tool.key)} onClick={() => repair.setTool(tool.id !== "build" && state.tool === tool.id ? "build" : tool.id)}>
        <span className="city-repair-glyph" aria-hidden="true">{tool.icon}</span><span className="city-repair-name">{tool.label}</span><kbd>{tool.key}</kbd>
      </button>)}
      <hr />
      <button onClick={repair.undo} disabled={!info.canUndo} title="撤销（⌘Z）"><span className="city-repair-glyph" aria-hidden="true">↶</span><span className="city-repair-name">撤销</span></button>
      <button onClick={repair.redo} disabled={!info.canRedo} title="重做（⇧⌘Z）"><span className="city-repair-glyph" aria-hidden="true">↷</span><span className="city-repair-name">重做</span></button>
      <button className={issues ? "is-active" : ""} onClick={issues ? repair.closeAudit : repair.audit} title="检查楼压路、楼重叠、坡地等布局问题，以及车开不过去的桥头与陡路"><span className="city-repair-glyph" aria-hidden="true">✓</span><span className="city-repair-name">体检</span></button>
      <button className={confirmReset ? "city-repair-danger is-confirm" : "city-repair-danger"} onClick={onReset} disabled={total === 0 && info.staleCount === 0} title="丢弃全部修改，回到生成的样子（可撤销）"><span className="city-repair-glyph" aria-hidden="true">⟲</span><span className="city-repair-name">{confirmReset ? "确认？" : "还原"}</span></button>
      <hr />
      <button className="city-repair-exit" onClick={repair.exit} aria-label="退出修复规划" title="退出修复（Esc 先逐级取消）"><span className="city-repair-glyph" aria-hidden="true">✕</span><span className="city-repair-name">退出</span></button>
    </div>
  </section>, language);
}
