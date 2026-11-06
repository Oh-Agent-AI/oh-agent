/**
 * 高架落地端低段禁行区（2026-10-19）。
 *
 * 开放高架（ringRuns 的断头段）在两端各用 EXPRESSWAY_RAMP（90）的 ease 剖面从桥面落到地面：落地后约 50 内
 * 桥面底离路面不到车辆净空。骨架阶段这段只压着自己的宿主路；之后扇区街网、街网缝合、入口路陆续加的地面路
 * 并不知道这段高架是低的——0/42（seed 42 tier 1 Miami）的高架 0 就在两端各被 2–3 条 5 宽支路压着：沿程 24–44
 * 处桥面底比车道高 −0.7…+1.3，桥面板就是车道上的固体，车开不过去，出生路线卡死。
 *
 * 这里把每个开放端的低段铺成一串预留圆盘，并进连接器的 reservations：连接器路线与 commitFixedLink 的地面段
 * 都按 reservations 做用地净距，桥面段不查——新地面路因此绕开低段，跨越只能发生在高架已经够高的地方。
 * 骨架已提交的路（包括宿主路）不受影响。圆盘从 START 开始，让开落地区本身（宿主路与匝道在那里本来就相交）。
 */
import { EXPRESSWAY_DECK_WIDTH } from "../roadStandard";
import type { Vec2 } from "../cityLayout";

export const RAMP_LOW_ZONE = {
  /** 落地端起算：这段之内是落地区，不设禁行。 */
  start: 6,
  /** 落地端起算：桥面底到此处已高于车辆净空（ease 剖面实测约 2.3）。 */
  end: 48,
  step: 4,
  /** 高架桥面半宽（与 skeleton 出口弦净空的 EXPRESSWAY_DECK_WIDTH / 2 同口径）。 */
  radius: EXPRESSWAY_DECK_WIDTH / 2,
};

export type RampLowZoneDisc = Vec2 & { radius: number; kind: "ramp-low-zone"; id: string };

export function rampLowZoneDiscs(runs: readonly (readonly Vec2[])[]): RampLowZoneDisc[] {
  const out: RampLowZoneDisc[] = [];
  runs.forEach((run, r) => {
    if (run.length < 2 || Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01) return; // 闭合环线没有落地端
    for (const [end, pts] of [["from", run], ["to", [...run].reverse()]] as const) {
      let along = 0, next = RAMP_LOW_ZONE.start;
      for (let i = 1; i < pts.length && next <= RAMP_LOW_ZONE.end; i++) {
        const a = pts[i - 1], b = pts[i], length = Math.hypot(b.x - a.x, b.z - a.z);
        while (next <= RAMP_LOW_ZONE.end && next <= along + length) {
          const t = length > 0 ? (next - along) / length : 0;
          out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, radius: RAMP_LOW_ZONE.radius, kind: "ramp-low-zone", id: `ramp-low-zone:${r}:${end}:${next}` });
          next += RAMP_LOW_ZONE.step;
        }
        along += length;
      }
    }
  });
  return out;
}
