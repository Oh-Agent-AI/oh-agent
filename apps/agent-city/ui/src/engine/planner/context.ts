import type { Landmark } from "../cityPlan";
import type { CityBlock, PublicSite, Vec2 } from "../cityLayout";
import type { SeasideBand } from "../citySeaside";
import type { Network } from "./network";
import type { Geography } from "./geography";
import type { ConnectionAttempt } from "./connect";
import type { ConnectionDemand } from "./intent";
import type { PlanningWorld } from "./world";

/**
 * 规划尾部修复遍用到的成员（CITY_ARCHITECTURE §2 迁移步 5b；V2 步 2b-lite 起路网原语走 network 对象）。
 * 原先这些遍内联在 buildPlan 末尾、直接引用闭包变量；现在显式列出——一个遍用到什么，一眼可见。
 * 全是「引用」：network/sites/blocks 就是 buildPlan 里的同一份可变对象，修复遍原地改它们（加边走 addNetworkEdge）。
 * 只收尾部遍真正读的成员；要加新遍用到新成员，先加到这里。
 */
export interface RepairContext {
  network: Network;
  connectionLog?: ConnectionAttempt[];
  primaryAnchorNodeId?: string | null;
  siteObligations?: Array<{ ownerId: string; placed: boolean; reason?: string }>;
  /** Persistent commitments; only the transaction dispatcher may update bindings. */
  demandCatalogue?: readonly ConnectionDemand[];
  /** Dispatcher-owned authority. Pending reservations do not certify complete model physics. */
  readonly planningWorld?: PlanningWorld;
  height: (x: number, z: number) => number;
  inRiver: (x: number, z: number) => boolean;
  publicSites: PublicSite[];
  landmarks: Landmark[];
  blocks: CityBlock[];
  /** 环线高架折线（用地不得压在其下）。 */
  ringRuns: Vec2[][];
  coast: Vec2[];
  core: Vec2;
  /** 主干折线（distanceToTrunks 经 footprint.polylineDistance 计算）。 */
  trunkRuns: Vec2[][];
  /** 过河桥（nearBridgeEnd 经 footprint 纯函数计算）。 */
  bridges: Array<{ from: Vec2; to: Vec2 }>;
  /** 地理阶段产物（safeRoadLink 的 buildable/slope 来源）。 */
  geo: Geography;
  SHORE_SITE_KINDS: Set<string>;
  /** 车流折线（海滨大道回路、街区回路）：去冗余的修复不得拆掉它们走的路段，否则整条回路被丢弃。 */
  carPaths: Vec2[][];
  /** 海滨带（plannedEndWorld 的滨海大道合法断点来源；网络优先批次 1）。 */
  seaside: SeasideBand | null;
  /** 沿海/河岸路各 run 的首尾点（计划内终点；批次 1）。 */
  coastRoadRunEnds: Vec2[];
  /** 沿海路段（批次 8：solve 的违例测量需要 plan 视图）。 */
  coastRoadRuns: Vec2[][];
  /** Production coastRoadRuns includes river runs; exclude that suffix in intent. */
  coastalRunCount?: number;
  /** 河岸路段（同上）。 */
  riverRoadRuns: Vec2[][];
}
