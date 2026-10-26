/**
 * CityMechaSite → MatchState 的唯一入口（整改规格 §3.4，ARCH-4）。
 * 界面的 fresh() 和测试的 open() 以前各手写一份 createMatch 参数，两份都会丢信息：
 * blocked 格（SITE-1）进不了规则，非 siege 脚本看不到城里的楼（SITE-2）。
 * 这里只做转换，不调 bossPrepare——何时开第一回合是调用方的事。
 */
import type { CityMechaSite } from "./citySite";
import { createMatch, type BossScriptId, type BuildingStake, type CoverPresetId, type MatchState } from "./rules";

export function matchFromSite(
  site: CityMechaSite,
  opts: { preset: CoverPresetId; script: BossScriptId; stake?: BuildingStake },
): MatchState {
  const { preset, script, stake } = opts;
  return createMatch({
    preset,
    script,
    covers: [],
    terrain: site.terrain.map((row) => row.slice()),
    heights: site.heights.map((row) => row.slice()),
    // D2 = b（整改规格 §4，2026-10-26）：城市战场上每个脚本都带楼、都守楼。
    // 以前只有 siege/raid_ssw 带楼，砸砸扫和站桩砸击里城里画着的楼对规则不存在，机甲能穿楼而过。
    buildings: site.buildings.map((building) => ({ id: building.id, cells: building.cells.map((cell) => ({ ...cell })) })),
    raiders: script === "siege" ? site.raiders.map((raider) => ({ id: raider.id, pos: { ...raider.pos } })) : [],
    mechs: site.mechs.map((mech) => ({ id: mech.id, pos: { ...mech.pos } })),
    boss: { ...site.boss },
    // 场景楼/斜放楼不是掩体：走 obstacles，不走 covers（掩体可穿射、会被当目标）。
    obstacles: site.blocked.map((cell) => ({ ...cell })),
    stake,
  });
}
