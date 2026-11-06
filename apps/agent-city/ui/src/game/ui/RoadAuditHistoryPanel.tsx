import { useState } from "react";
import type { CityEngine } from "../../engine/CityEngine";
import type { RoadAuditHistoryEntry, AuditHistoryClip } from "../RoadAuditHistory";
import type { ReadyCitySurfaceCapture } from "../../engine/surface/citySurfacePort";
function Clip({clip,locate,en}:{clip:AuditHistoryClip;locate:((x:number,z:number)=>void)|null;en:boolean}) {
  const [index,setIndex]=useState(0);
  const frame=clip.frames[Math.min(index,clip.frames.length-1)];
  if(!frame)return null;
  return <details><summary>{en?"Recorded failure frames":"故障记录逐帧查看"} · {clip.caseId}</summary>
    <p>{en?"Recorded diagnostics, not a new physics replay or road certificate.":"这是记录回放，未重新运行物理，也不构成道路认证。"}</p>
    {clip.truncated&&<p>{en?"Only the bounded tail of this run was retained.":"仅保留该次试跑末尾的有限帧。"}</p>}
    <input type="range" min={0} max={clip.frames.length-1} step={1} value={Math.min(index,clip.frames.length-1)}
      aria-label={en?"Recorded frame":"记录帧"} onChange={(event)=>setIndex(Number(event.target.value))} />
    <p>tick {frame.tick} · ({frame.x.toFixed(2)}, {frame.y.toFixed(2)}, {frame.z.toFixed(2)}) · {en?"speed":"速度"} {frame.speed.toFixed(2)} · {frame.buttons||"—"}</p>
    <button type="button" disabled={!locate} onClick={()=>locate?.(frame.x,frame.z)}>{en?"Locate recorded position":"定位记录位置"}</button>
    {!locate&&<small>{en?"The matching live snapshot is unavailable; map relocation is disabled.":"对应的实时快照不可用，已禁用地图定位。"}</small>}
  </details>;
}
export function RoadAuditHistoryPanel({entries,saved,capture,engineRef,en}:{entries:readonly RoadAuditHistoryEntry[];saved:boolean;
  capture:ReadyCitySurfaceCapture|null;engineRef:React.RefObject<CityEngine|null>;en:boolean}) {
  return <details><summary>{en?"Local diagnostic history":"本地诊断历史"} ({entries.length}/8)</summary>
    <p>{en?"History is diagnostic only. It never restores a graph, lease or driving permission.":"历史记录仅供诊断，不会恢复开放图、场景租约或驾驶权限。"}</p>
    {!saved&&<p role="status">{en?"Local storage unavailable; this result is kept only for the current view.":"本地存储不可用，本次结果仅在当前页面保留。"}</p>}
    {entries.map((entry)=><details key={entry.id}><summary>{new Date(entry.at).toLocaleString(en?"en-US":"zh-CN")} · {entry.publication==="published"?(en?"Past strict-policy verification":"曾通过严格策略验证"):(en?"Not published":"未发布")}</summary>
      <p>{entry.reason} · {en?"Passed / blocked / inconclusive / excluded":"通过 / 阻塞 / 无结论 / 排除"}：{entry.counts.passed} / {entry.counts.blocked} / {entry.counts.inconclusive} / {entry.counts.excluded}</p>
      {entry.truncated&&<p>{en?"This record is incomplete: retention limits or unfinished cases.":"记录不完整：受留存容量限制，或存在未完成用例。"}</p>}
      {entry.failures.map((failure)=><p key={failure.caseId}><code>{failure.caseId}</code> · {failure.verdict} · {failure.cause} · {failure.detail}</p>)}
      {entry.clips.map((clip)=><Clip key={`${clip.phase}:${clip.caseId}`} clip={clip} en={en}
        locate={capture?.worldRevision===entry.worldRevision&&capture.isLeaseCurrent()?(x,z)=>{if(capture.isLeaseCurrent())engineRef.current?.focusPoint(x,z);}:null} />)}
    </details>)}
  </details>;
}
