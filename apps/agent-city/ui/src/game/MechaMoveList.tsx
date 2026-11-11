/** The classic HUD's keyboard-accessible movement picker. */
export function MechaMoveList({ id, summary, label, placeholder, applyText, options, value, disabled, onChange, onApply }: {
  id: string;
  summary: string;
  label: string;
  placeholder: string;
  applyText: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onApply: () => void;
}) {
  return <details className="mecha-move-list">
    <summary>{summary}</summary>
    <label htmlFor={id}>{label}</label>
    <div className="mecha-move-controls">
      <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>
        <option value="" disabled>{placeholder}</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button type="button" disabled={disabled || !options.some(option => option.value === value)} onClick={onApply}>{applyText}</button>
    </div>
  </details>;
}
