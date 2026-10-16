import { Fragment, type KeyboardEvent } from "react";
import { GitBranch, GitPullRequest } from "lucide-react";
import { groupByPr } from "../repos.ts";
import type { Chunk, MergeRun, Repo } from "../state.ts";
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

// The repo base, then the chunks grouped under their PR, in order.
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
  const groups = groupByPr(chunks);
  return (
    <ul className="flex flex-col rounded-lg border">
      {repo.base && (
        <li {...base} className={cn("flex items-center gap-3 px-3 py-2 text-sm", base.className)} title={pickBase && "Whole repo"}>
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={repo.base}>
            {repo.base}
          </code>
        </li>
      )}
      {groups.map((g, gi) => (
        <Fragment key={g.head?.name ?? `no-pr-${gi}`}>
          {/* A single group with no PR (before the PRs exist) needs no header. */}
          {(g.head || groups.length > 1) && (
            <li className="flex items-center gap-2 border-t px-3 py-1.5 text-sm" style={{ paddingLeft: repo.base ? "calc(0.75rem + 1.75rem)" : undefined }}>
              {g.head ? (
                <>
                  <Button asChild variant="ghost" size="sm">
                    <a href={g.head.pr} target="_blank">
                      <GitPullRequest /> {prLabel(g.head.pr!)}
                    </a>
                  </Button>
                  {(g.head.status === "merged" || g.head.status === "closed") && <ChunkStatusIcon status={g.head.status} />}
                </>
              ) : (
                <span className="text-xs text-muted-foreground">No PR yet</span>
              )}
            </li>
          )}
          {g.chunks.map((c) => {
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
                style={{ paddingLeft: repo.base ? "calc(0.75rem + 3.25rem)" : undefined }}>
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
                </span>
              </li>
            );
          })}
        </Fragment>
      ))}
    </ul>
  );
}
