import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import type { GameLocale } from "./gameCopy";
import "./MechaQuickGuide.css";

export type MechaQuickGuideProps = {
  locale: GameLocale;
  /** Optional fallback when the menu item that opened the guide is unmounted. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Called for the close button or Escape; the host must unmount the guide. */
  onClose: () => void;
};

const COPY = {
  "zh-Hans": {
    title: "战斗快速指南",
    introduction: "本地战斗的基本流程；具体目标和可用操作以当前对局为准。打开指南不会暂停自动或远程对局。",
    close: "关闭指南",
    steps: [
      { title: "部署", detail: "本地开局部署时，选择机甲，再选择绿色可部署格（也可使用坐标列表）。放好三台后确认部署；确认后才出现首回合敌意。" },
      { title: "查看预告", detail: "红色斜纹表示当前敌方攻击的危险格；蓝色虚线是按草稿或所选目标试算的预测，不是已结算结果。预测未知不等于安全。" },
      { title: "规划", detail: "选择机甲，按需选择可到达的移动格，再为每台存活机甲明确选择行动，包括待机。选择目标时可查看效果与推挤落点；确认目标不等于提交整队。" },
      { title: "提交", detail: "检查草稿后选择“结束回合”。整队计划会一起校验；若被拒绝，局面不变，可修改后重试。结算先完成全队移动，再依次执行我方行动和敌方行动；战斗结束时会跳过后续阶段。" },
      { title: "回放与记录", detail: "结算记录展示实际事件，不是预测。符合条件的本地 PvE 对局可在结束后重播；本机战斗回放可在战场设置中管理，保存或播放可能因存储或兼容性失败。远程对局不支持本机回放。" },
    ],
  },
  en: {
    title: "Quick battle guide",
    introduction: "The basics of local battles; objectives and available controls depend on the match. This guide does not pause auto-play or remote matches.",
    close: "Close guide",
    steps: [
      { title: "Deploy", detail: "When local deployment is available, select a mech and a green valid placement cell (or use the coordinate list). Place all three and confirm; the first enemy intentions appear after confirmation." },
      { title: "Read the telegraph", detail: "Red stripes mark the current enemy attack's danger cells. Blue dashes show a prediction based on the draft or selected target, not a resolved outcome. An unknown prediction does not mean safety." },
      { title: "Plan", detail: "Select a mech, optionally choose a reachable movement cell, then explicitly choose an action for each surviving mech, including wait. Inspect effects and push landing when choosing a target; confirming a target does not submit the team plan." },
      { title: "Submit", detail: "Review the draft, then select End turn. The team plan is validated together; if rejected, the board stays unchanged and you can edit and retry. Resolution completes team movement first, then mech actions and enemy actions; later stages are skipped if the battle ends." },
      { title: "Replay and records", detail: "The turn record shows actual events, not predictions. Eligible local PvE matches can be replayed after they end; manage local battle replays in Battlefield settings. Saving or playback may fail due to storage or compatibility. Remote matches do not support local replay." },
    ],
  },
} as const;

/** Mount only at the player's request. The guide stores no state and does not alter the match. */
export function MechaQuickGuide({ locale, onClose, returnFocusRef }: MechaQuickGuideProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const introductionId = useId();
  const copy = COPY[locale];

  useLayoutEffect(() => {
    if (!dialog.current) return;
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (element.open) element.close();
      const returnTarget = returnFocusRef?.current?.isConnected ? returnFocusRef.current : opener;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, []);
  return <dialog
    ref={dialog}
    className="mecha-quick-guide"
    data-mecha-quick-guide=""
    lang={locale}
    aria-labelledby={titleId}
    aria-describedby={introductionId}
    onCancel={event => { event.preventDefault(); onClose(); }}
  >
    <div className="mecha-quick-guide__content">
      <header className="mecha-quick-guide__header">
        <div>
          <h2 id={titleId}>{copy.title}</h2>
          <p id={introductionId}>{copy.introduction}</p>
        </div>
        <button ref={closeButton} type="button" className="mecha-quick-guide__close" onClick={onClose}>{copy.close}</button>
      </header>
      <ol className="mecha-quick-guide__steps">
        {copy.steps.map(step => <li key={step.title}>
          <h3>{step.title}</h3>
          <p>{step.detail}</p>
        </li>)}
      </ol>
    </div>
  </dialog>;
}
