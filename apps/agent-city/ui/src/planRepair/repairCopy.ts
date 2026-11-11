/**
 * 修复城市面板文案（中/英）。zh 是源文案（controller.ts / planAudit.ts 直接产出中文），en 在呈现期翻译：
 * 精确对照表 + 带数字/标签的模板正则，未命中的文案原样返回（宁可留中文也不编造译文）。
 * 同 game/gameCopy.ts：自成一组，不进 i18n.tsx 的全局表。
 *
 * 新增 controller 消息时：在这里补一条（精确文案进 EXACT，带参数的进 PATTERNS），
 * scripts/verify-plan-repair-copy.mjs 会用 controller 的真实文案表校验覆盖。
 */
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export const EXACT: Record<string, string> = {
  // 工具与选项
  "移动": "Move", "画路": "Road", "橡皮擦": "Erase", "改路": "Restyle", "路口": "Junction", "设施": "Sites",
  "撤销": "Undo", "重做": "Redo", "体检": "Audit", "还原": "Reset", "确认？": "Sure?", "退出": "Exit", "未修改": "Clean",
  "路型": "Road type", "画法": "Style",
  "小路": "Street", "次干道": "Collector", "主干道": "Arterial", "滨海大道": "Seafront", "高架": "Viaduct",
  "直线": "Straight", "弧线": "Arc",
  "点选任意建筑，再点空地搬过去：会话楼搬到你选的地块，设施、地标、市政用地搬到任意空地": "Pick any building, then click open land to move it: session buildings go to the plot you choose; sites, landmarks and civic land to any open spot",
  "点两下画一段路，可连续画": "Click twice to draw a road; keep clicking to chain",
  "点击红色高亮的路段擦掉": "Click a highlighted road segment to erase it",
  "选路型后点一条路：整条街改成这个路型": "Pick a road type, then click a road to restyle the whole street",
  "点一个路口拿起来，再点一下放下：连着的路跟着走": "Pick up a junction and drop it elsewhere; connected roads follow",
  "编辑非会话建筑：公共设施、花园、地标、市政用地、背景楼——搬家或拆除": "Edit non-session buildings: public facilities, gardens, landmarks, civic land, backdrop — move or demolish",
  "宽 5，街区内的支路": "Width 5, local streets inside blocks",
  "宽 8": "Width 8",
  "宽 12，城市骨架级": "Width 12, the city's backbone",
  "宽 12，沿路向海一侧铺滨海景观带（步道、矮墙、路灯）": "Width 12, with a seafront promenade (walkway, low wall, lamps) on the sea side",
  "逐点点击画折线，可跨河跨路，两端自动落地成匝道；回车完成": "Click points to draw a polyline; may cross rivers and roads, ends ramp down automatically; Enter to finish",
  "点两下画一段直路；从路尽头拐弯自动倒圆，过河自动架桥": "Click twice for a straight road; turns off a road end are rounded, river crossings become bridges",
  "点起点、路要经过的点、终点，画一段弧线路；弯的急缓有下限（按路型）": "Click start, a point the road passes through, then the end; minimum curve radius depends on road type",
  "撤销（⌘Z）": "Undo (⌘Z)", "重做（⇧⌘Z）": "Redo (⇧⌘Z)",
  "检查楼压路、楼重叠、坡地等布局问题，以及车开不过去的桥头与陡路": "Check layout problems (buildings on roads, overlaps, slopes) and roads cars can't get through (bad bridgeheads, steep roads)",
  "丢弃全部修改，回到生成的样子（可撤销）": "Discard all edits and return to the generated city (undoable)",
  "退出修复（Esc 先逐级取消）": "Exit repair (Esc cancels step by step first)",
  "退出修复规划": "Exit repair",
  "规划修复": "City repair", "修复工具": "Repair tools",
  "尚无修改": "No edits yet", "修改已保存": "Edits saved", "本次修改仅临时生效（存档失败）": "Edits are temporary (saving failed)",
  // 面板控件
  "知道了": "Got it", "清除失效修改": "Clear stale edits", "定位": "Locate", "完成": "Finish", "拆除": "Demolish", "擦掉": "Erase",
  "回车": "Enter", "拆除选中的设施（Delete）": "Demolish the selected site (Delete)", "一次擦掉，撤销可恢复": "Erase all at once; undo restores them",
  "逆时针转 90°（[）": "Rotate 90° counter-clockwise ([)", "顺时针转 90°（]）": "Rotate 90° clockwise (])",
  "收起体检": "Hide audit", "体检通过：没有发现布局或道路问题": "Audit passed: no layout or road problems found",
  "楼压路": "Building on road", "楼重叠": "Buildings overlap", "坡地/不可建": "Slope / unbuildable", "街区无路": "Block without road", "补丁失效": "Stale edit",
  "桥头斜接": "Oblique bridgehead", "桥头过陡": "Steep bridgehead", "陡路": "Steep road",
  "错误": "Error", "警告": "Warning", "提示": "Note",
  "选中：": "Selected: ", "不可行：": "Not possible: ", "注意：": "Note: ", "指向：": "Pointing at: ", "（点击选中）": " (click to select)",
  "计数:移楼": "Buildings moved", "计数:画路": "Roads drawn", "计数:擦路": "Roads erased", "计数:高架": "Viaducts", "计数:改路口": "Junctions moved", "计数:改设施": "Site edits", "条已失效": "stale",
  "你的修改造成": "From your edits", "生成时就有": "Already generated", "已保存": "Saved", "保存中…": "Saving…", "仅临时": "Temporary",
  "修改会自动保存在本机，关闭或重启后仍在": "Edits save automatically on this Mac and survive closing or restarting",
  // 提示（controller HINT）
  "点选任意建筑（会话楼、设施、地标、市政用地），再点要搬去的空地": "Pick any building (session building, facility, landmark, civic land), then click the open spot to move it to",
  "点一下落起点（会吸附到路口或路面），再点一下落笔；可连续画，拐弯自动倒圆。结束：右键、再点一下终点或 Esc": "Click to set the start (snaps to junctions and roads), click again to place; keep chaining, turns are rounded. To finish: right-click, click the end point again, or Esc",
  "把橡皮擦移到道路上，红色高亮的路段点击即擦掉": "Move the eraser over a road; click the red highlighted segment to erase it",
  "先选路型，再把鼠标移到路上：整条街高亮，点一下就改成这个路型（变宽会推平/安置两侧的楼；桥面不能改）": "Pick a road type, then hover a road: the whole street highlights; click to restyle (widening bulldozes/relocates buildings on both sides; bridge decks can't change)",
  "点选任意非会话建筑（公共设施、花园、地标、市政用地、背景楼）；再点空地搬家，或点「拆除」": "Pick any non-session building (facility, garden, landmark, civic land, backdrop); click open land to move it, or choose Demolish",
  "点一个路口拿起来，移动鼠标预览，再点一下放下；Esc 放回原处": "Pick up a junction, move the mouse to preview, click to drop; Esc puts it back",
  "弧线：点起点，再点路要经过的点，最后点终点；可连续画，Esc 撤回上一步，C 切回直线": "Arc: click the start, a point the road passes through, then the end; keep chaining, Esc undoes a step, C switches back to straight",
  "起点已落下：点一下路要经过的地方（弧线会穿过它）": "Start set: click where the road should pass (the arc goes through it)",
  "高架：逐点点击画折线（可跨河、跨路），回车或在最后一点上再点一下完成；Esc 撤回上一个点": "Viaduct: click points to draw a polyline (may cross rivers and roads); Enter or click the last point again to finish; Esc removes the last point",
  // 消息
  "高架至少要两个点：再点一个点": "A viaduct needs at least two points: add one more",
  "已架好一条高架": "Viaduct built",
  "已选中，但附近没有可搬去的空地块": "Selected, but there is no open plot nearby to move to",
  "这里是海滨或基础设施装饰（沙滩、码头、桥），不是建筑，不能移动": "This is shoreline or infrastructure decoration (beach, pier, bridge), not a building; it can't be moved",
  "这里没有可落位的地块": "There is no plot here to place it on",
  "它已经在这个地块上了": "It is already on this plot",
  "已搬过去": "Moved",
  "起点已落下，接着逐点点击；回车或在最后一点上再点一下完成": "Start set; keep clicking points; Enter or click the last point again to finish",
  "起点已落下，移动鼠标预览，再点一下落笔；右键或 Esc 放弃这个起点": "Start set; move the mouse to preview, click to place; right-click or Esc discards the start",
  "经过点已定：移动鼠标预览弧线，点终点落笔；Esc 重新选经过点": "Pass-through set: move the mouse to preview the arc, click the end to place; Esc re-picks the point",
  "已画一段，接着点下一个点；右键、再点一下这个终点或 Esc 结束": "Road drawn; click the next point; right-click, click this end point again, or Esc to finish",
  "已结束这条路线，可以点新的起点": "Route finished; click a new start to begin another",
  "它已经在这里了": "It is already here",
  "已切掉一截高架（断口各自落地成匝道）": "Viaduct cut (each end ramps down to the ground)",
  "这里没有道路可擦": "No road to erase here",
  "已擦掉一段路": "Road segment erased",
  "高架不是地面路的路型：改路请选小路、次干道、主干道或滨海大道": "Viaduct isn't a ground road type: restyle with Street, Collector, Arterial or Seafront",
  "这里没有道路": "There is no road here",
  "这条路已经是这个路型了": "This road already has that type",
  "这里没有路口——把鼠标移到路口上（蓝色圆环）再点": "No junction here — hover a junction (blue ring) and click",
  "已移动路口": "Junction moved",
  "选中的设施已不在城市里": "The selected site is no longer in the city",
  "选中的楼已不在城市里": "The selected building is no longer in the city",
  "已撤销": "Undone", "已重做": "Redone", "已恢复生成": "Restored to the generated city",
  "已清除失效的修改（撤销可恢复）": "Stale edits cleared (undo restores them)",
  "道路宽度不符合标准：请选择支路、次干道或主干道": "Non-standard road width: choose a local road, collector or arterial",
  // 阻断原因（controller BLOCKER_TEXT）
  "该地块已被其他会话楼、配套或背景楼占用": "This plot is taken by another session building, facility or backdrop building",
  "楼会压到道路上": "The building would sit on a road",
  "会和其他会话楼重叠": "It would overlap another session building",
  "地块坡度太陡": "The plot is too steep",
  "该处不可建设（水面或岩岸）": "Can't build here (water or rocky shore)",
  "高架净空不足": "Not enough clearance under the viaduct",
  "地块不存在（城市已重排）": "The plot no longer exists (the city was re-laid out)",
  "这栋楼不在当前城市里": "This building is not in the current city",
  "桥面由桥梁模型绑定，不能单独编辑（橡皮擦可以整座擦掉）": "Bridge decks are bound to the bridge model and can't be edited alone (the eraser removes the whole bridge)",
  "桥头离路口或落笔点太近：桥两端各要一段直引道（小路 14、次干道 16、主干道 18）——把起点/终点往岸上多拉一点，别在桥头附近穿过别的路": "The bridgehead is too close to a junction or the stroke end: each end needs a straight approach (14 for local, 16 for secondary, 18 for main roads) — pull the start/end further inland and don't cross other roads near the bridgehead",
  "桥头岸坡太陡，车开不上桥——换个岸坡缓的地方过河": "The bank at the bridgehead is too steep for cars — cross where the bank is gentler",
  "这样接会在路口留下一块车开不上去的路面（驾驶面解不出）——换个接入点或角度": "Joining here would leave a patch of road cars can't drive on (the driving surface can't be resolved) — pick another joining point or angle",
  "路口夹角太小（小于 50°）：车拐不过来——请接近直角接入，或先接到别处再拐": "The junction angle is too sharp (under 50°): cars can't make the turn — join closer to a right angle, or join elsewhere and turn",
  "太陡了：坡比超过车的爬坡上限 0.31，车开不上去——换条缓一点的线，或用弧线绕着坡走": "Too steep: the grade exceeds the 0.31 cars can climb — pick a gentler line, or curve around the slope",
  "这条路很陡（坡比超过 0.2），车开得上去但很吃力": "This road is steep (grade above 0.2): cars can climb it, but only just",
  "点一条路或一座桥试驾：车沿它来回各开一遍，告诉你开不开得过去": "Click a road or a bridge to test-drive it: a car drives it both ways and tells you whether it gets through",
  "点一条路或一座桥：车沿它来回各开一遍，告诉你开不开得过去": "Click a road or a bridge: a car drives it both ways and tells you whether it gets through",
  "这里没有道路可试驾": "There is no road here to test-drive",
  "这段路太短，试驾不了——点它连着的长一点的路": "This segment is too short to test-drive — click a longer road connected to it",
  "试驾中…": "Test-driving…", "试驾": "Test drive",
  "修复方案": "Fix proposal", "采用": "Apply", "取消": "Cancel", "已放弃修复方案": "Fix proposal dismissed",
  "擦掉整座桥和岸边残路，在附近画一座直桥——先预览，点「采用」才写入": "Erase the whole bridge and its leftover shore roads, then draw a straight bridge nearby — previewed first, written only when you click Apply",
  "一步写入，撤销可恢复；写入后自动试驾新桥": "Applied as one step (undo restores it); the new bridge is test-driven right after",
  "放弃这个方案（Esc）": "Dismiss this proposal (Esc)",
  "有一岸附近没有能接上的路": "no road to join on one of the banks", "试过的落笔都不跨水": "none of the tried strokes crosses water",
  "岸坡太陡": "the bank is too steep", "桥头离路口太近": "the bridgehead is too close to a junction",
  "落笔点在水里，或一笔要跨两段水": "an end lands in water, or the stroke crosses water twice", "水面太宽，地面桥架不过去": "the water is too wide for a ground bridge",
  "桥面会穿过别的路": "the deck would cross another road", "引道太陡": "the approach is too steep", "接入的路口夹角太小": "the junction angle is too sharp",
  "没有可试的落笔点": "no stroke to try", "这里已经不是桥面了": "this is no longer a bridge deck",
  "车轮悬空：路面在这里接不上": "wheels off the surface: the road surfaces don't join here",
  "台阶太高或车轮别住：路面在这里有高差": "a step or a wheel twist: the road surface has a height jump here",
  "撞上路缘：路在这里太窄或拐得太急": "hit a curb: the road is too narrow or turns too sharply here",
  "坡太陡：车爬不上去": "too steep: the car can't climb it",
  "会压到悬索桥（它是路网里的一段桥面）": "It would hit the suspension bridge (a deck segment of the road network)",
  "这座设施已锁定": "This site is locked",
  "主干道是城市骨架，不能擦": "Arterials are the city's backbone and can't be erased",
  "擦掉后有楼离最近的路超过 40": "Erasing would leave a building more than 40 from the nearest road",
  "擦掉后有楼会和路网断开": "Erasing would cut a building off from the road network",
  "太短了（至少 6）": "Too short (minimum 6)",
  "太长了（最多 800）": "Too long (maximum 800)",
  "新路必须接到现有道路上": "A new road must connect to an existing road",
  "弯太急：小路最小转弯半径 15、次干道 24、主干道 36——把经过点挪得离起终点连线近一些": "Too tight: minimum turning radius is 15 for streets, 24 for collectors, 36 for arterials — move the pass-through point closer to the start–end line",
  "弧线不能过水——过河请切回直线画（会自动架桥）": "Arcs can't cross water — switch to a straight road to cross a river (a bridge is built automatically)",
  "不能修到水面或岩岸上（起点或终点在水里，或一笔要跨两段水——地面桥一笔只跨一段水面）": "Can't build on water or rocky shore (an end is in water, or one stroke spans two water stretches — a ground bridge spans only one)",
  "水面太宽，地面桥最长 160——请改用高架": "Water is too wide; ground bridges max out at 160 — use a viaduct",
  "桥上不能有路口：新路会在水面上和别的路交叉": "No junctions on a bridge: the new road would cross another road over water",
  "会穿过建筑、配套或花园": "It would pass through a building, facility or garden",
  "与现有道路交叉——请在交叉点连接": "It crosses an existing road — connect at the crossing",
  "路口夹角太小（小于 30°）": "Junction angle too small (under 30°)",
  "这里已经有路了": "There is already a road here",
  "起点和终点是同一个路口": "Start and end are the same junction",
  "目标处已有路口": "There is already a junction at the target",
  "路段不存在": "The road segment no longer exists",
  "路口不存在": "The junction no longer exists",
  "位置没有变化": "The position did not change",
  "城市尚未就绪": "The city isn't ready yet",
  "目标已被占用（会话楼、配套、花园或背景楼）": "The target is occupied (session building, facility, garden or backdrop)",
  "会压到道路上": "It would sit on a road",
  "这块街区的真实形状装不下它（会越出街区边界或压到街区里的空地/水塘）": "The block's real shape can't hold it (it would cross the block edge or cover its open land/pond)",
  "这里没有可落位的街区或地块": "There is no block or plot here to place it on",
  "高架太短（至少 30）": "Viaduct too short (minimum 30)",
  "匝道落地点在水里——高架两端要落在陆地上，或接到已有高架上": "A ramp lands in water — viaduct ends must land on ground or join an existing viaduct",
  "这里没有高架": "There is no viaduct here",
  "城市已随数据增长扩大了一档，旧修改已失效——请先在面板上点「清除失效修改」": "The city grew a tier with your data and old edits are stale — use “Clear stale edits” in the panel first",
  "城市生成规则更新了，旧修改已失效——请先在面板上点「清除失效修改」": "City generation rules were updated and old edits are stale — use “Clear stale edits” in the panel first",
  // 警告
  "已搬出它所属的小区": "Moved out of its own district",
  "会留下一个断头路": "It would leave a dead-end road",
  "移动距离很远": "A long move",
  "擦掉的是主干道": "You are erasing an arterial",
  "擦掉的是滨海路": "You are erasing a seafront road",
  "擦掉桥头引道后，桥会和路网断开": "Erasing the bridge approach would disconnect the bridge from the network",
  "将擦掉整座桥——桥头两侧的路留作断头，可以用画路工具重画一座直桥": "The whole bridge will be erased — the roads at both ends stay as dead ends; redraw a straight bridge with the road tool",
  "将擦掉整座悬索桥（塔架与主缆一起拆）——桥头两侧的路留作断头，可以用画路工具重画一座直桥": "The whole suspension bridge will be erased (towers and cables too) — the roads at both ends stay as dead ends; redraw a straight bridge with the road tool",
  "有楼会离最近的路超过 40（楼还在，只是没有路通到）": "A building would be more than 40 from the nearest road (it stays, but no road reaches it)",
  "有楼会和主路网断开": "A building would be cut off from the main network",
  "这段路两端都没接上路网": "Neither end of this road connects to the network",
  "会形成夹角小于 30° 的路口": "It would create a junction with an angle under 30°",
  "新位置附近没有能顺手接上的路（会压到建筑或入水），需要你用画路工具接一条": "No road nearby can be joined easily (it would hit buildings or water); connect one with the Road tool",
  "不到 180，桥面升不到全高（两端各要 90 的匝道）": "Under 180: the deck can't reach full height (each end needs a 90 ramp)",
  "将接上已有高架（接缝处不落地）": "It will join an existing viaduct (no ramp at the seam)",
  "高架会断成两条，断口各自落地成匝道": "The viaduct will split in two; each cut end ramps down",
  "离海岸较远——滨海景观带会铺在离海近的一侧": "Far from the coast — the seafront promenade goes on the side nearer the sea",
  "改掉的是滨海路——沿路的滨海景观带会撤掉": "You are restyling a seafront road — its promenade will be removed",
  "主干道会变窄": "The arterial will become narrower",
  "桥的上方有高架（净空请自己看一眼）": "A viaduct passes over the bridge (check the clearance yourself)",
  // 标签
  "学校": "School", "商场": "Mall", "医院": "Hospital", "城区花园与景观湖": "District garden and lake", "城区地标": "District landmark", "背景楼": "Backdrop building",
  "电视塔": "TV tower", "帆形歌剧院": "Sail opera house", "凯旋拱门": "Triumphal arch", "宝塔": "Pagoda", "灯塔": "Lighthouse", "摩天轮": "Ferris wheel",
  "悬索桥": "Suspension bridge", "双子塔": "Twin towers", "扭转塔": "Twist tower", "地中海庄园": "Mediterranean estate",
  "市政厅": "Civic hall", "车站": "Station", "体育场": "Stadium", "城市公园": "City park", "观景塔": "Observation tower", "港口与码头": "Harbor and piers",
  "公共设施": "Public facility", "地标": "Landmark", "市政用地": "Civic land",
};

type Translate = (text: string) => string;
const list = (text: string, t: Translate) => text.split("；").map(t).join("; ");
const FAIL_VERB: Record<string, string> = { 不能这样架: "Can't build it that way", 不能搬到这里: "Can't move it here", 不能这样画: "Can't draw it that way", 不能拆除: "Can't demolish", 不能切: "Can't cut", 不能擦: "Can't erase", 不能改: "Can't restyle", 不能放在这里: "Can't drop it here" };
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray, t: Translate) => string]> = [
  [/^将在交叉处自动生成 (\d+) 个路口$/, (m) => `${m[1]} junction(s) will be created where roads cross`],
  [/^将推平 (\d+) 座设施$/, (m) => `${m[1]} site(s) will be bulldozed`],
  [/^将由开发商就近安置 (\d+) 栋会话楼$/, (m) => `The developer will rehome ${m[1]} session building(s) nearby`],
  [/^推平了 (\d+) 座设施$/, (m) => `Bulldozed ${m[1]} site(s)`],
  [/^开发商安置了 (\d+) 栋会话楼$/, (m) => `The developer rehomed ${m[1]} session building(s)`],
  [/^(\d+) 栋会话楼附近没有空地块，仍压在路上$/, (m) => `${m[1]} session building(s) have no open plot nearby and still sit on the road`],
  [/^(\d+) 栋会话楼附近没有空地块，会留在路上$/, (m) => `${m[1]} session building(s) have no open plot nearby and would stay on the road`],
  [/^在新位置补了一条 (\d+) 长的接入路$/, (m) => `Added an access road of length ${m[1]} at the new spot`],
  [/^水面段将架成一座 (\d+) 长的桥$/, (m) => `The water stretch will become a bridge of length ${m[1]}`],
  [/^已撤回一个点（还有 (\d+) 个）$/, (m) => `Removed a point (${m[1]} left)`],
  [/^已选中，附近有 (\d+) 个可搬去的空地块（绿色）；点任一地块搬过去$/, (m) => `Selected; ${m[1]} open plot(s) nearby (green) — click one to move there`],
  [/^已点 (\d+) 个点；回车完成，Esc 撤回上一个点$/, (m) => `${m[1]} point(s) placed; Enter to finish, Esc removes the last`],
  [/^(不能这样架|不能搬到这里|不能这样画|不能拆除|不能切|不能擦|不能改|不能放在这里)：(.+)$/s, (m, t) => `${FAIL_VERB[m[1]]}: ${list(m[2], t)}`],
  [/^不能从这里接路：(.+)$/, (m, t) => `Can't connect a road from here: ${t(m[1])}`],
  [/^这个路口不能拖：(.+)$/, (m, t) => `This junction can't be dragged: ${t(m[1])}`],
  [/^已搬过去（(.+)）$/, (m, t) => `Moved (${list(m[1], t)})`],
  [/^已架好一条高架（(.+)）$/, (m, t) => `Viaduct built (${list(m[1], t)})`],
  [/^已画一段（(.+)），接着点下一个点$/, (m, t) => `Road drawn (${list(m[1], t)}); click the next point`],
  [/^已擦掉一段路（(.+)）$/, (m, t) => `Road segment erased (${list(m[1], t)})`],
  [/^已改成(小路|次干道|主干道|滨海大道)（(.+)）$/, (m, t) => `Restyled to ${t(m[1]).toLowerCase()} (${list(m[2], t)})`],
  [/^已改成(小路|次干道|主干道|滨海大道)$/, (m, t) => `Restyled to ${t(m[1]).toLowerCase()}`],
  [/^已移动路口（(.+)）$/, (m, t) => `Junction moved (${list(m[1], t)})`],
  [/^已选中(.+?)：点地面任意空地搬过去——靠近路会自动贴路、正门朝路（\[ \/ \] 转向），或点「拆除」；原址的接入路(或堤道)?会留下$/, (m, t) =>
    `${t(m[1])} selected: click any open ground to move it — near a road it snaps to it with the front door facing it ([ / ] rotates), or choose Demolish; its old access road${m[2] ? " or causeway" : ""} stays`],
  [/^已选中(.+?)，附近有 (\d+) 个可搬去的(空街区|空地块)（绿色）；点任一处搬过去，或点「拆除」$/, (m, t) =>
    `${t(m[1])} selected; ${m[2]} open ${m[3] === "空街区" ? "block(s)" : "plot(s)"} nearby (green) — click one to move there, or choose Demolish`],
  [/^已选中(.+?)，但附近没有可搬去的(空街区|空地块)；可以拆除$/, (m, t) => `${t(m[1])} selected, but no open ${m[2] === "空街区" ? "block" : "plot"} nearby; you can demolish it`],
  [/^这里没有可落位的(街区|地块)$/, (m) => `There is no ${m[1] === "街区" ? "block" : "plot"} here to place it on`],
  [/^已把(.+?)搬过去（(.+)）$/, (m, t) => `${t(m[1])} moved (${list(m[2], t)})`],
  [/^已把(.+?)搬过去$/, (m, t) => `${t(m[1])} moved`],
  [/^已拆除(.+?)（撤销可恢复）$/, (m, t) => `${t(m[1])} demolished (undo restores it)`],
  [/^原址留下 (\d+) 段断头接入路，可在面板上一键擦掉$/, (m) => `${m[1]} dead-end access segment(s) left behind; erase them in one click from the panel`],
  [/^已擦掉原址的 (\d+) 段接入路（撤销可恢复）$/, (m) => `Erased ${m[1]} old access segment(s) (undo restores them)`],
  [/^已拿起路口（连着 (\d+) 段路）：移动鼠标预览，再点一下放下；Esc 放回原处$/, (m) => `Junction picked up (${m[1]} road(s) attached): move to preview, click to drop; Esc puts it back`],
  [/^(.+)（预估，鼠标停住后给出确切结果）$/, (m, t) => `${list(m[1], t)} (estimate; exact result once the mouse rests)`],
  [/^选中：(.+)$/, (m, t) => `Selected: ${t(m[1])}`],
  [/^指向：(.+)（点击选中）$/, (m, t) => `Pointing at: ${t(m[1])} (click to select)`],
  [/^高架已点 (\d+) 个点$/, (m) => `Viaduct: ${m[1]} point(s)`],
  [/^(\d+) 处修改$/, (m) => `${m[1]} edit(s)`],
  [/^(\d+) 处$/, (m) => `${m[1]} edit(s)`],
  [/^(\d+) 个问题(?:（显示前 (\d+) 个）)?$/, (m) => `${m[1]} problem(s)${m[2] ? ` (first ${m[2]} shown)` : ""}`],
  [/^会话楼 (.+) 落在不可建地形上$/, (m) => `Session building ${m[1]} sits on unbuildable terrain`],
  [/^会话楼 (.+) 所在地块坡度超过 (.+)$/, (m) => `Session building ${m[1]} stands on a plot steeper than ${m[2]}`],
  [/^会话楼 (.+) 压在道路上$/, (m) => `Session building ${m[1]} sits on a road`],
  [/^会话楼 (.+) 与 (.+) 的占地相交$/, (m) => `Session buildings ${m[1]} and ${m[2]} overlap`],
  [/^街区 (.+) 有楼但离最近道路 (\d+)（> (\d+)）$/, (m) => `Block ${m[1]} has buildings but is ${m[2]} from the nearest road (> ${m[3]})`],
  [/^补丁条目失效（(.+)）：(.+)$/, (m) => `Edit is stale (${m[1]}): ${m[2]}`],
  [/^修复方案：擦掉整座桥(?:和 (\d+) 段岸边残路)?，在绿色处画一座 (\d+) 的直桥(?:（(.+)）)?——点「采用」写入，Esc 放弃$/, (m, t) =>
    `Fix proposal: erase the whole bridge${m[1] ? ` and ${m[1]} leftover shore road(s)` : ""}, draw a straight ${m[2]} bridge where it's green${m[3] ? ` (${list(m[3], t)})` : ""} — click Apply to write it, Esc to dismiss`],
  [/^找不到自动修复方案：(.+)——可以用橡皮擦整座擦掉这座桥，再自己画$/, (m, t) => `No automatic fix found: ${t(m[1])} — you can erase the whole bridge with the eraser and draw one yourself`],
  [/^附近找不到一笔合法的直桥（(.+)）$/, (m, t) => `no valid straight bridge nearby (${list(m[1], t)})`],
  [/^这座桥擦不掉（(.+)）$/, (m, t) => `this bridge can't be erased (${list(m[1], t)})`],
  [/^已按方案重建这座桥（撤销可恢复）(?:；(.+))?$/, (m, t) => `Bridge rebuilt as proposed (undo restores it)${m[1] ? `; ${t(m[1])}` : ""}`],
  [/^方案写不进去：(.+)$/, (m, t) => `The proposal couldn't be applied: ${t(m[1])}`],
  [/^试驾通过：车沿(这座桥|这条路)来回都开得过去$/, (m) => `Test drive passed: a car gets through ${m[1] === "这座桥" ? "this bridge" : "this road"} both ways`],
  [/^试驾挡住：车在红点处过不去（(.+)）——(可以整座擦掉重画一座直桥|可以擦掉绕开重画)$/, (m, t) => `Test drive blocked: the car can't get past the red dot (${t(m[1])}) — ${m[2] === "可以整座擦掉重画一座直桥" ? "erase the whole bridge and redraw a straight one" : "erase it and redraw around"}`],
  [/^试驾未判定：这次没开完（(.+)），不代表路不通$/, (m, t) => `Test drive undetermined: this run didn't finish (${t(m[1])}); that doesn't mean the road is blocked`],
  [/^桥头斜接：下桥最顺的一条路也要转 (\d+)°（> 45°），车下桥就得急转、车身会越出桥面——用橡皮擦整座擦掉这座桥，再画一座直桥$/, (m) =>
    `Oblique bridgehead: even the straightest road off the bridge turns ${m[1]}° (> 45°), so cars must swerve and run off the deck — erase the whole bridge with the eraser and draw a straight one`],
  [/^桥头岸坡太陡：坡比 ([\d.]+)（车的爬坡上限 ([\d.]+)），车上不了桥——擦掉这座桥，在岸坡缓的地方重画$/, (m) =>
    `Steep bridgehead: bank grade ${m[1]} (cars climb at most ${m[2]}), cars can't get onto the bridge — erase it and redraw where the bank is gentler`],
  [/^这段路坡比 ([\d.]+)，超过车的爬坡上限 ([\d.]+)，车开不上去——擦掉它，绕缓坡重画$/, (m) =>
    `This road has grade ${m[1]}, above the ${m[2]} cars can climb — erase it and redraw along a gentler slope`],
  [/^这段路坡比 ([\d.]+)，接近车的爬坡上限 ([\d.]+)$/, (m) => `This road has grade ${m[1]}, close to the ${m[2]} cars can climb`],
];

/** 呈现期翻译一棵元素树里的字符串子节点与 title / aria-label（同 i18n.tsx::cityView，但走本模块的对照表）。 */
export function repairView(node: ReactNode, locale: string): ReactNode {
  if (locale !== "en") return node;
  if (typeof node === "string") return repairText(node, locale);
  if (Array.isArray(node)) return Children.map(node, (child) => repairView(child, locale));
  if (!isValidElement(node) || typeof node.type === "function") return node;
  const element = node as ReactElement<Record<string, unknown>>;
  const props: Record<string, unknown> = {};
  for (const key of ["aria-label", "title"]) if (typeof element.props[key] === "string") props[key] = repairText(element.props[key] as string, locale);
  if (element.props.children !== undefined) props.children = repairView(element.props.children as ReactNode, locale);
  return cloneElement(element, props);
}

export function repairText(text: string, locale: string): string {
  if (locale !== "en") return text;
  const t: Translate = (s) => {
    const exact = EXACT[s];
    if (exact !== undefined) return exact;
    for (const [pattern, render] of PATTERNS) {
      const match = s.match(pattern);
      if (match) return render(match, t);
    }
    if (s.includes("；")) return list(s, t);
    return s;
  };
  return t(text);
}
