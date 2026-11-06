import type { ComponentProps, ReactNode } from "react";

type FieldWidth = "short" | "medium" | "wide" | "fill";

export function Field({ label, htmlFor, width = "fill", hint, error, children }: {
  label: string;
  htmlFor: string;
  width?: FieldWidth;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return <div className={`av-field av-field-${width}`}>
    <label htmlFor={htmlFor} className="av-field-label">{label}</label>
    {children}
    {error ? <small className="av-field-error" role="alert">{error}</small> : hint ? <small className="av-field-hint">{hint}</small> : null}
  </div>;
}

export function TextInput({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`av-control ${className}`.trim()} {...props} />;
}

export function DateInput({ className = "", type, ...props }: Omit<ComponentProps<"input">, "type"> & { type: "date" | "month" }) {
  return <input className={`av-control ${className}`.trim()} type={type} {...props} />;
}

export function SelectInput({ className = "", ...props }: ComponentProps<"select">) {
  return <select className={`av-control ${className}`.trim()} {...props} />;
}

export function FilterBar({ children, className = "", ...props }: ComponentProps<"section">) {
  return <section className={`av-filter-bar ${className}`.trim()} {...props}>{children}</section>;
}

export function Button({ variant = "secondary", size = "regular", className = "", busy = false, disabled, children, ...props }: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "regular" | "compact";
  busy?: boolean;
}) {
  return <button className={`av-button av-button-${variant} av-button-${size} ${className}`.trim()} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>{children}</button>;
}
