import type { KeyboardEvent } from "react";
import { GitPullRequest } from "lucide-react";
import type { Chunk, MergeRun, Repo } from "../state.ts";
import { ChunkStatusIcon } from "./status";
import { cn, prNumber } from "./utils";

// "#12" for a GitHub PR URL; other hosts keep the plain label.
const prLabel = (url: string) => {
  const n = prNumber(url);
  return n ? `#${n}` : "PR";
};

// The chunk status stands for its PR once it has one; any other status is a PR still open.
const PR_STATE: Record<string, { label: string; className: string }> = {
  merged: { label: "Merged", className: "text-violet-600 dark:text-violet-400" },
  closed: { label: "Closed", className: "text-red-600 dark:text-red-400" },
};
const PR_OPEN = { label: "Open", className: "text-emerald-600 dark:text-emerald-400" };

// Row props for a clickable row: a button for the mouse, Enter and Space.
function clickable(pick: (() => void) | undefined, isSelected: boolean) {
  return {
    className: cn(
      pick && "outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
      isSelected && "bg-accent",
    ),
    ...(pick && {
      role: "button",
      tabIndex: 0,
      "aria-pressed": isSelected,
      onClick: pick,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        pick();
      },
    }),
  };
}

// The rail of the branch chain: a node per row, joined by a line above and/or below it.
function Rail({ up, down, hollow }: { up: boolean; down: boolean; hollow?: boolean }) {
  return (
    <span aria-hidden className="relative flex w-3 shrink-0 items-center justify-center">
      {(up || down) && <span className={cn("absolute left-1/2 w-px -translate-x-1/2 bg-border", up && down ? "inset-y-0" : up ? "top-0 bottom-1/2" : "top-1/2 bottom-0")} />}
      <span className={cn("relative size-2.5 rounded-full border-2 border-muted-foreground/60", hollow ? "bg-background" : "bg-muted-foreground/60")} />
    </span>
  );
}

// The PR sits on the top chunk: its number, and its state.
function PrPill({ chunk }: { chunk: Chunk }) {
  const state = PR_STATE[chunk.status ?? ""] ?? PR_OPEN;
  return (
    <a
      href={chunk.pr}
      target="_blank"
      title={`Pull request ${prLabel(chunk.pr!)}`}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent"
      onClick={(e) => e.stopPropagation()}>
      <GitPullRequest className="size-3.5" />
      <span className="font-medium">{prLabel(chunk.pr!)}</span>
      <span className={cn("flex items-center gap-1", state.className)}>
        <span className="size-1.5 rounded-full bg-current" />
        {state.label}
      </span>
    </a>
  );
}

// The repo base, then the chunks in order, joined by a rail. The PR pill sits on the chunk that carries the PR.
export function ChunkList({ repo, chunks, merge, selected, onSelect, onSelectBase }: {
  repo: Repo;
  chunks: Chunk[];
  merge?: MergeRun;
  selected?: string; // selected chunk name
  onSelect?: (chunk: string) => void; // rows with a branch are clickable
  onSelectBase?: () => void; // the base row stands for the whole repo; selected while no chunk is
}) {
  const pickBase = onSelectBase && chunks.some((c) => c.branch) ? onSelectBase : undefined;
  const base = clickable(pickBase, !!pickBase && selected === undefined);
  return (
    <ul className="flex flex-col rounded-lg border">
      {repo.base && (
        <li {...base} className={cn("flex items-stretch gap-3 px-3 text-sm", base.className)} title={pickBase && "Whole repo"}>
          <Rail up={false} down={chunks.length > 0} hollow />
          <div className="flex min-w-0 items-center py-2">
            <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={repo.base}>
              {repo.base}
            </code>
          </div>
        </li>
      )}
      {chunks.map((c, i) => {
        // A finished merge ("done") leaves every row on its own status.
        const mergeHere = merge && merge.status !== "done" && merge.current === c.name ? merge : undefined;
        // A chunk without a branch has no diff to show.
        const pick = onSelect && c.branch ? () => onSelect(c.name) : undefined;
        const row = clickable(pick, selected === c.name);
        return (
          <li key={c.name} {...row} className={cn("flex items-stretch gap-3 px-3 text-sm", row.className)}>
            <Rail up={i > 0 || !!repo.base} down={i < chunks.length - 1} />
            <div className="flex min-w-0 flex-1 items-center gap-3 py-2">
              <span className="shrink-0 whitespace-nowrap font-medium">{c.name}</span>
              {c.branch && (
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={c.branch}>
                  {c.branch}
                </code>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {mergeHere ? (
                  <ChunkStatusIcon
                    status={mergeHere.status === "running" ? "merging" : "failed"}
                    title={mergeHere.status === "failed" ? `merge stopped: ${mergeHere.error}` : "merging"}
                  />
                ) : (
                  c.status && <ChunkStatusIcon status={c.status} />
                )}
                {c.pr && <PrPill chunk={c} />}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
