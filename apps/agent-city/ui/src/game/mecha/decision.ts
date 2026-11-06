export interface DecisionPlanner<S, P> {
  plan(state: S): P;
}
