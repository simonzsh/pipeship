import type { DashboardState } from "../state.ts";
import { displaySteps } from "./pipeline-info";
import { StatusBadge, statusConfig } from "./status";
import { Steps } from "./steps";
import { cn } from "./utils";

export function PipelineListItem({ p, selected, onSelect }: { p: DashboardState; selected: boolean; onSelect: () => void }) {
  const { tint, hover } = statusConfig(p.status);
  const refs = p.ticket.links.map((l) => l.ref).join(", ");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        tint,
        hover,
        selected ? "border-foreground/30 bg-card shadow-sm ring-1 ring-foreground/10" : "border-transparent",
      )}
    >
      <span className="truncate text-sm font-medium">{p.ticket.title}</span>
      <span className="flex items-center gap-2">
        <StatusBadge status={p.status} />
        {refs && <span className="min-w-0 truncate text-xs text-muted-foreground">{refs}</span>}
      </span>
      <Steps steps={displaySteps(p)} compact />
    </button>
  );
}
