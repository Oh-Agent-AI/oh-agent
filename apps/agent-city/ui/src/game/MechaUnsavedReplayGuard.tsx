import { useLayoutEffect, useRef } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import "./MechaMatchResult.css";

/** A second top-layer dialog can sit above the result dialog without closing it. */
export function MechaUnsavedReplayGuard({ locale, onCancel, onConfirm }: {
  locale: GameLocale; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const t = (text: string) => gameText(text, locale);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="mecha-match-result mecha-unsaved-replay-guard" data-replay-unsaved-guard aria-labelledby="mecha-unsaved-replay-title" aria-describedby="mecha-unsaved-replay-description" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="mecha-match-result__body">
      <h2 id="mecha-unsaved-replay-title">{t("本局回放尚未保存")}</h2>
      <p id="mecha-unsaved-replay-description" className="mecha-match-result__cause">{t("继续将丢失本局回放。返回战场设置可手动保存到本机。")}</p>
      <div className="mecha-match-result__actions">
        <button type="button" className="mecha-match-result__primary" data-replay-guard-cancel autoFocus onClick={onCancel}>{t("保留本局")}</button>
        <button type="button" data-replay-guard-confirm onClick={onConfirm}>{t("不保存，继续")}</button>
      </div>
    </div>
  </dialog>;
}
