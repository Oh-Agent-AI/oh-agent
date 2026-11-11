import type { FoldProjection } from "./mecha/skillPhaseField";
import { describeSpaceFold } from "./mecha/spaceFoldPresentation";

/** Read-only preview; callers must provide the current authoritative projection. */
export function MechaSpaceFoldPreview({ projection, locale }: { projection: FoldProjection; locale: "zh" | "en" }) {
  const result = describeSpaceFold(projection, locale);
  const en = locale === "en";
  if (result.status === "unavailable") return <p role="status" data-space-fold-unavailable>{en ? "Space fold unavailable" : "空间折叠不可用"}: {result.reason}</p>;
  return <section aria-label={en ? "Space fold preview" : "空间折叠预览"} data-space-fold-preview>
    <p>{en ? "Projected mapping, not yet applied" : "预测映射，尚未生效"}</p>
    <ol>{result.mapping.map((item, index) => <li key={index}>{item}</li>)}</ol>
    <p>{en ? "Projected unit movement" : "预测单位位移"}</p>
    {result.moves.length ? <ol>{result.moves.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p>{en ? "No units move" : "没有单位移动"}</p>}
  </section>;
}
