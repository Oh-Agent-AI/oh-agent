import type { PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceSplitterKind } from "./useWorkspaceLayout";

/**
 * 三栏之间的拖动分隔条。双击恢复默认比例；聚焦后 ←/→ 每次 16px，
 * 这样键盘用户也能调宽度（分隔条是 role=separator，不是装饰 div）。
 */
export function WorkspaceSplitter(props: Readonly<{
  kind: WorkspaceSplitterKind;
  label: string;
  dragging: boolean;
  width: number;
  min: number;
  max: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onReset: () => void;
  onNudge: (delta: number) => void;
}>) {
  return <div className="workspace-splitter" role="separator" aria-orientation="vertical" aria-label={props.label}
    data-split={props.kind} data-dragging={props.dragging ? "true" : undefined}
    aria-valuenow={props.width} aria-valuemin={props.min} aria-valuemax={props.max} tabIndex={0}
    title="拖动调整栏宽，双击恢复默认"
    onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove}
    onPointerUp={props.onPointerUp} onPointerCancel={props.onPointerUp}
    onDoubleClick={props.onReset}
    onKeyDown={event => {
      const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      if (!delta) return;
      event.preventDefault();
      props.onNudge(delta);
    }} />;
}
