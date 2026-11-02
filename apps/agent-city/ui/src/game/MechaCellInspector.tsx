import type { GameLocale } from "./gameCopy";
import { MechaUnitPortrait } from "./MechaUnitAvatar";
import { describeUnitIdentity } from "./mecha/unitIdentity";
import type { CellInspection } from "./mecha/cellInspection";

export function MechaCellInspector({ info, locale, onClose, compact = false }: { info: CellInspection; locale: GameLocale; onClose: () => void; compact?: boolean }) {
  const en = locale === "en";
  const text = (zh: string, english: string) => en ? english : zh;
  const terrain = { land: text("地面", "Ground"), water: text("水域", "Water"), mountain: text("山地", "Mountain"), road: text("道路", "Road") }[info.terrain];
  const object = { empty: terrain, unit: info.unit ? describeUnitIdentity(info.unit.id, locale).label : "?", cover: text("掩体", "Cover"), obstacle: text("场景障碍", "Obstacle"), building: text("建筑", "Building"), rubble: text("废墟", "Rubble") }[info.object];
  const terrainDescription = {
    land: text("可通行；平地基础花费 2 半步，陡上坡基础花费 4 半步。", "Passable. Base cost: 2 half-steps; steep uphill: 4."),
    water: text("不能进入；射击可穿过。推入水域视为撞墙，并非落水死亡。", "Impassable; shots pass through. Shoving into water causes a collision, not drowning."),
    mountain: text("可攀爬，基础花费 4 半步；阻挡射击；被推入视为撞墙。", "Climbable. Base cost: 4 half-steps; blocks shots. Shoving into it causes a collision."),
    road: text("可通行；机甲和小怪有道路减耗，大怪无道路增益。", "Passable. Mechs and raiders receive a road cost discount; the boss does not."),
  }[info.terrain];
  const blocked = ["building", "rubble", "cover", "obstacle"].includes(info.object);
  const attack = info.attack;
  const content = <>    {info.unit ? <p className="mecha-inspection-stats">HP {info.unit.hp}/{info.unit.maxHp ?? "?"} · {text("攻击", "ATK")} {info.unit.atk} · {text("防御", "DEF")} {info.unit.def} · {text("移动", "MOV")} {info.unit.move}</p> : null}
    {info.building ? <p>HP {info.building.hp}/{info.building.maxHp}{info.object === "rubble" ? ` · ${text("已毁", "Destroyed")}` : ""}</p> : null}
    {attack ? <div className="mecha-inspection-intent" data-attack-source="declared"><strong>{text("当前宣告", "Declared attack")} · {attack.skill === "sweep" ? text("横扫", "Sweep") : attack.skill === "smash" ? text("砸击", "Smash") : text("无攻击", "No attack")}</strong><p>{attack.targets.length ? `${text("红色箭头 → 攻击落点", "Red arrows → attack cells")} ${attack.targets.map(c => `(${c.x},${c.y})`).join(" ")}` : attack.status === "missing" ? text("没有可用宣告；不推测攻击路线。", "No declaration available; no route inferred.") : text("当前宣告无有效攻击落点。", "The declaration has no active attack cells.")}</p></div> : null}
    {info.movePath?.length ? <p className="mecha-inspection-move">{text("绿色路线 · 我方移动草稿，尚未执行", "Green route · friendly draft move, not executed")}</p> : null}
    <details><summary>{text("地形与规则", "Terrain & rules")}</summary><p>{terrainDescription}</p>{blocked ? <p>{text("此格被占据：阻挡移动和普通射击。", "Occupied: blocks movement and normal shots.")}</p> : null}{attack ? <p>{text("敌方移动已在回合准备时完成；箭头是攻击方向，不是未来移动路径。推挤可能改变落点，蓝色 P 格是整包草稿预测。", "Enemy movement completed during preparation. Arrows show attack directions, not future movement. Shoves may change cells; blue P marks are whole-draft predictions.")}</p> : null}{info.unit?.cd != null ? <p>{text("技能冷却", "Skill cooldown")} {info.unit.cd}</p> : null}</details>
  </>;
  return <section className="mecha-cell-inspector" data-cell={`${info.cell.x},${info.cell.y}`} data-inspected-unit={info.unit?.id} aria-label={text("方格属性", "Tile information")} tabIndex={0}>
    <header>
      {info.unit ? <MechaUnitPortrait unitId={info.unit.id} locale={locale} size={compact ? 28 : 38} /> : <span className={`mecha-tile-icon is-${info.terrain}`} aria-hidden="true">{info.terrain === "water" ? "≈" : info.terrain === "mountain" ? "▲" : info.terrain === "road" ? "═" : "◇"}</span>}
      <div><strong>{info.object === "empty" ? text("查看地形", "Inspect terrain") : text("查看对象", "Inspect object")} · {object}{compact && info.unit ? ` · HP ${info.unit.hp}/${info.unit.maxHp ?? "?"}` : ""}</strong><small>({info.cell.x},{info.cell.y}) · {terrain} · {text("高度", "Height")} {Number(info.height.toFixed(1))}</small></div>
      <button type="button" onClick={onClose} aria-label={text("关闭属性", "Close information")}>×</button>
    </header>
    {compact ? <details className="mecha-compact-inspection"><summary>{attack ? `${text("当前宣告", "Declared attack")} · ${attack.skill === "sweep" ? text("横扫", "Sweep") : attack.skill === "smash" ? text("砸击", "Smash") : text("无攻击", "No attack")}` : text("单位与地形属性", "Unit & terrain information")}</summary>{content}</details> : content}
  </section>;
}
