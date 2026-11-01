import type { Action } from "./mecha/rules";
const paths: Record<Action["kind"], string> = {
  skip: "M9 5v14M15 5v14",
  melee: "M5 15l5-9 9 4-2 9H8zM10 6v6h8",
  shoot: "M3 10h13l5 2-5 2H3zM8 14v5M5 7h6",
  charge: "M3 12h16M14 6l6 6-6 6M4 6h4M4 18h4",
  pierce: "M4 19h16M8 18l6-12 4 2-6 11M4 9l2-4 4 1",
  repair: "M14 3a6 6 0 0 0-7 7l-4 8 3 3 8-7a6 6 0 0 0 7-7l-4 4-4-4z",
};
export function MechaActionIcon({ kind }: { kind: Action["kind"] }) {
  return <svg className="mecha-action-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d={paths[kind]} /></svg>;
}
