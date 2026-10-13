import type { DashboardState } from "../state.ts";

// chunk undefined = whole stack (one diff per repo with at least one branch).
export type DiffTarget = { chunk?: string };

export interface CodeTabProps {
  p: DashboardState;
  target: DiffTarget;
  onTarget: (t: DiffTarget) => void;
}

// PLACEHOLDER: the diff-view chunk replaces this body and keeps the exports.
export function CodeTab({ target }: CodeTabProps) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      Diff: {target.chunk ?? "Whole stack"}
    </div>
  );
}
