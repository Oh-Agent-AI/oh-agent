import { useId, type ReactNode } from "react";

export function AgentDecisionCard({ title, children, tone = "review" }: {
  title: string;
  children: ReactNode;
  tone?: "review" | "error";
}) {
  const heading = useId();
  return <section className="agent-decision-card" data-tone={tone} aria-labelledby={heading}>
    <h3 id={heading}>{title}</h3>
    {children}
  </section>;
}
