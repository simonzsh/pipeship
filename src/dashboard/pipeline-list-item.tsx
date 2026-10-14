import { GitMerge } from "lucide-react";
import type { DashboardState } from "../state.ts";
import { allMerged, displaySteps, timeAgoShort } from "./pipeline-info";
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
        // Selection shows as a border, so the status tint stays visible.
        selected ? "border-foreground/30 shadow-sm ring-1 ring-foreground/10" : "border-transparent",
      )}
    >
      <span className="truncate text-sm font-medium">
        {refs && <span className="mr-1.5 text-xs font-normal text-muted-foreground">{refs}</span>}
        {p.ticket.title}
      </span>
      <span className="flex items-center justify-between gap-2">
        <Steps steps={displaySteps(p)} compact />
        <span className="flex items-center gap-1.5">
          {allMerged(p) && (
            <span title="All PRs merged" className="inline-flex">
              <GitMerge className="size-3.5 text-violet-600 dark:text-violet-400" aria-label="All PRs merged" />
            </span>
          )}
          <StatusBadge status={p.status} />
          <span title={`Updated ${p.updatedAt}`} className="text-xs tabular-nums text-muted-foreground">
            {timeAgoShort(p.updatedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}
