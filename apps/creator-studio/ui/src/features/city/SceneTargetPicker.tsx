import { useEffect, useRef, useState } from "react";
import type { CityEngine } from "../../../../../agent-city/ui/src/engine/CityEngine";
import { nearestRoadTarget } from "../../../../../agent-city/ui/src/engine/planRoadRules";

/** Mounted only for an isolated, generated authoring scene. */
export function SceneTargetPicker({ getEngine, onSelect }: {
  getEngine: () => CityEngine | null;
  onSelect: (target: string) => void;
}) {
  const [engine, setEngine] = useState<CityEngine | null>(null);
  const [hint, setHint] = useState("");
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    if (!engine) return;
    const cancel = () => { setEngine(null); setHint(""); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    engine.setCursor("crosshair");
    engine.setRepairHook({ onSecondary: cancel, onClick({ pickedId, ground }) {
      const road = !pickedId && ground && engine.currentLayout && nearestRoadTarget(engine.currentLayout, ground.x, ground.z);
      const target = pickedId ? `场景对象 ${pickedId}` : road ? `${road.kind === "edge" ? "道路" : "路口"} ${road.id}` : null;
      if (!target) { setHint("此处没有可关联的对象，请点击建筑或道路"); return; }
      select.current(target);
      cancel();
    } });
    window.addEventListener("keydown", key);
    return () => { engine.setRepairHook(null); engine.setCursor(""); window.removeEventListener("keydown", key); };
  }, [engine]);
  return <div className="scene-target-picker"><button type="button" aria-pressed={!!engine} onClick={() => {
    if (engine) { setEngine(null); setHint(""); return; }
    const ready = getEngine();
    setEngine(ready);
    setHint(ready ? "点选建筑或道路，Esc 取消" : "等待城市加载完成");
  }}>{engine ? "取消选择" : "关联场景对象"}</button>{hint && <span role="status">{hint}</span>}</div>;
}
