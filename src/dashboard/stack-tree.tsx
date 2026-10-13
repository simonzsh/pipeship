import type { KeyboardEvent } from "react";
import { GitBranch, GitPullRequest } from "lucide-react";
import type { Chunk, MergeRun } from "../state.ts";
import { Button } from "./components/ui/button";
import { ChunkStatusIcon } from "./status";
import { cn, prNumber } from "./utils";

// "#12" for a GitHub PR URL; other hosts keep the plain label.
const prLabel = (url: string) => {
  const n = prNumber(url);
  return n ? `#${n}` : "PR";
};

// Row props for a clickable row: a button for the mouse, Enter and Space.
function clickable(pick: (() => void) | undefined, isSelected: boolean) {
  return {
    className: cn(
      pick && "cursor-pointer outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
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

// The stack is linear: each PR targets the previous one, so depth is the index (plus one under the base root).
export function StackTree({ base, chunks, merge, selected, onSelect, onSelectBase }: {
  base?: string;
  chunks: Chunk[];
  merge?: MergeRun;
  selected?: string; // selected chunk name
  onSelect?: (chunk: string) => void; // rows with a branch are clickable
  onSelectBase?: () => void; // the base row stands for the whole stack; selected while no chunk is
}) {
  const offset = base ? 1 : 0;
  const pickBase = onSelectBase && chunks.some((c) => c.branch) ? onSelectBase : undefined;
  const baseRow = clickable(pickBase, !!pickBase && selected === undefined);
  return (
    <ul className="flex flex-col rounded-lg border">
      {base && (
        <li {...baseRow} className={cn("flex items-center gap-3 px-3 py-2 text-sm", baseRow.className)} title={pickBase && "Whole stack"}>
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={base}>
            {base}
          </code>
        </li>
      )}
      {chunks.map((c, i) => {
        const depth = i + offset;
        // A finished merge ("done") leaves every row on its own status.
        const mergeHere = merge && merge.status !== "done" && merge.current === c.name ? merge : undefined;
        // A chunk without a branch has no diff to show.
        const pick = onSelect && c.branch ? () => onSelect(c.name) : undefined;
        const row = clickable(pick, selected === c.name);
        return (
          <li
            key={c.name}
            {...row}
            className={cn("flex items-center gap-3 px-3 py-2 text-sm", row.className)}
            style={{ paddingLeft: depth > 0 ? `calc(0.75rem + ${depth - 1} * 1.75rem)` : undefined }}>
            {/* The 1rem cell starts under the parent's icon (indent step 1.75rem = cell + gap) and spans the row (-my-2 undoes py-2).
                The elbow rises into the row above, ends 0.25rem under the parent's icon, and runs to 0.25rem before ours. */}
            {depth > 0 && (
              <span className="relative -my-2 w-4 shrink-0 self-stretch">
                <span
                  aria-hidden
                  className="absolute left-1/2 w-4 rounded-bl-md border-b border-l border-muted-foreground/40"
                  style={{ top: "calc(-50% + 0.75rem)", height: "calc(100% - 0.75rem)" }}
                />
              </span>
            )}
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
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
              {c.pr && (
                <Button asChild variant="ghost" size="sm">
                  <a href={c.pr} target="_blank" onClick={(e) => e.stopPropagation()}>
                    <GitPullRequest /> {prLabel(c.pr)}
                  </a>
                </Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
