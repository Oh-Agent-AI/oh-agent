import { useEffect, useState } from "react";
import { convertAmounts, onFxChanged, type FxConvertResult } from "./tauri";
import { stable } from "./stable";

/**
 * 把 `{币种: 金额}` 折成报告币种的约数（后端算，带出处）。键相同则不重取；设置里改了报告币种
 * 或手动汇率（`onFxChanged`）才重取。后台刷新不翻转状态：先保留上一份结果，新结果内容相同就沿用旧引用。
 * 折不了（含无桥接、后端报错）→ null，调用方回退到原币种分栏显示。
 */
export function useConvertedAmounts(amounts: Record<string, number>): FxConvertResult | null {
  const [state, setState] = useState<{ key: string; result: FxConvertResult | null } | null>(null);
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(Object.entries(amounts).filter(([, amount]) => amount > 0).sort());
  useEffect(() => onFxChanged(() => setVersion((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    const payload = Object.fromEntries(JSON.parse(key) as Array<[string, number]>);
    if (Object.keys(payload).length === 0) { setState(null); return () => { active = false; }; }
    void convertAmounts(payload).then((next) => { if (active) setState((previous) => ({ key, result: stable(previous?.key === key ? previous.result : null, next) })); }).catch(() => { if (active) setState(null); });
    return () => { active = false; };
  }, [key, version]);
  // 结果只对它当初请求的那一组金额有效：键变了（数据刷新 / 币种变化）而新结果还没到时，
  // 不把旧结果配给新金额。
  return state && state.key === key ? state.result : null;
}
