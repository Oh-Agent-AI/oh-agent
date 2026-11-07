import type { ReactNode } from "react";
import { MechaCommandDeck, MechaCommandPanel } from "./MechaHudPanels";
import { MechaMoveList } from "./MechaMoveList";
import { MechaActionCard } from "./MechaActionCard";
import type { MechId } from "./mecha/board";

export type SequentialRosterRow = {
  id: MechId;
  name: string;
  hp: number;
  selected: boolean;
  disabled: boolean;
  stateLabel: string;
  avatar: ReactNode;
};

export type SequentialHudAction = {
  key: string;
  label: string;
  target?: string;
  icon: ReactNode;
  selected: boolean;
  disabled: boolean;
  status?: string;
  title?: string;
};

export type SequentialHudDamage = { target: string; before: number; after: number };

/** Rule agnostic command view. It renders the 1.4 action deck from view data and callbacks. */
export function SequentialMechaCommandPanel({
  label, selectedName, hp, maxHp, portrait, movementLabel, moveOptions, moveChoice,
  moveDisabled, moveActionLabel, statusNote, actions, actionColumns,
  targetInstruction, targetPicker, previewTitle, previewMessage, damage, displacement, actionDisabled,
  onMoveChoice, onMoveApply, onSelectAction, onConfirmAction, onUndo, confirmActionDisabled,
  actionText, confirmText, undoText, moveListSummary, movePlaceholder, children,
}: {
  label: string;
  selectedName: string;
  hp: number;
  maxHp: number | string;
  portrait: ReactNode;
  movementLabel: string;
  moveOptions: Array<{ key: string; label: string }>;
  moveChoice: string;
  moveDisabled: boolean;
  moveActionLabel: string;
  statusNote?: string;
  actions: SequentialHudAction[];
  actionColumns: number;
  targetInstruction?: string;
  targetPicker?: ReactNode;
  previewTitle?: string;
  previewMessage?: string;
  damage: SequentialHudDamage[];
  displacement: string[];
  actionDisabled: boolean;
  confirmActionDisabled: boolean;
  onMoveChoice: (key: string) => void;
  onMoveApply: () => void;
  onSelectAction: (index: number) => void;
  onConfirmAction: () => void;
  onUndo: () => void;
  actionText: string;
  confirmText: string;
  undoText: string;
  moveListSummary: string;
  movePlaceholder: string;
  children?: ReactNode;
}) {
  return <MechaCommandPanel label={label}
    heading={<h3 tabIndex={-1}><span>{selectedName}</span><span className="mecha-selected-hp">{hp} / {maxHp} HP</span></h3>}
    instruction={<>{statusNote && <p className="mecha-v15-note" role="status">{statusNote}</p>}{targetInstruction && <p className="mecha-target-instruction">{targetInstruction}</p>}</>}
    deck={<MechaCommandDeck portrait={portrait} columns={actionColumns}>
      {actions.map((action, index) => <MechaActionCard key={action.key} type="button"
        className={action.disabled ? "is-unavailable" : action.selected ? "is-selected" : ""} title={action.title}
        aria-pressed={action.selected} disabled={action.disabled || actionDisabled}
        onClick={() => onSelectAction(index)} label={action.label + (action.target ? ` · ${action.target}` : "")} icon={action.icon} status={action.status ?? actionText} />)}
    </MechaCommandDeck>}
    utilities={<div className="mecha-actions mecha-action-utilities">
      <button type="button" className="mecha-submit-primary" disabled={confirmActionDisabled || actionDisabled} onClick={onConfirmAction}>{confirmText}</button>
      <button type="button" disabled={actionDisabled} onClick={onUndo}>{undoText}</button>
    </div>}
    target={<>{targetPicker}{previewTitle && <div className="mecha-v15-preview" aria-live="polite"><strong>{previewTitle}</strong>
      {previewMessage && <p>{previewMessage}</p>}
      {damage.length > 0 && <ul>{damage.map((item, index) => <li key={`${item.target}:${index}`}>{item.target}: {item.before} → {item.after}</li>)}</ul>}
      {displacement.map((message, index) => <p key={`${message}:${index}`}>{message}</p>)}
    </div>}</>}
    movement={<MechaMoveList id="v15-cell" summary={moveListSummary} label={movementLabel}
      placeholder={movePlaceholder} applyText={moveActionLabel} options={moveOptions.map(option => ({ value: option.key, label: option.label }))}
      value={moveChoice} disabled={moveDisabled} onChange={onMoveChoice} onApply={onMoveApply} />}
  >{children}</MechaCommandPanel>;
}
