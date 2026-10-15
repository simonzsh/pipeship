import type { KeyboardEvent } from "react";
import { GitBranch, GitPullRequest } from "lucide-react";
import type { Chunk, MergeRun, Repo } from "../state.ts";
import { stackRows } from "../repos.ts";
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

// Each PR sits under the branch it targets on GitHub: a retargeted PR moves in the tree.
export function StackTree({ repo, chunks, merge, selected, onSelect, onSelectBase }: {
  repo: Repo;
  chunks: Chunk[];
  merge?: MergeRun;
  selected?: string; // selected chunk name
  onSelect?: (chunk: string) => void; // rows with a branch are clickable
  onSelectBase?: () => void; // the base row stands for the whole stack; selected while no chunk is
}) {
  const pickBase = onSelectBase && chunks.some((c) => c.branch) ? onSelectBase : undefined;
  const rows = stackRows(chunks, repo);
  return (
    <ul className="flex flex-col rounded-lg border">
      {rows.map((r) => {
        if (r.kind === "root") {
          // Only the repo base stands for the whole stack; other roots are branches outside it.
          const isBase = r.branch === repo.base;
          const row = clickable(isBase ? pickBase : undefined, isBase && !!pickBase && selected === undefined);
          return (
            <li
              key={`root:${r.branch}`}
              {...row}
              className={cn("flex items-center gap-3 px-3 py-2 text-sm", row.className)}
              title={isBase ? pickBase && "Whole stack" : "Targeted by a PR, outside the stack"}>
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={r.branch}>
                {r.branch}
              </code>
            </li>
          );
        }
        // A second child's elbow rises past its elder sibling's subtree to the parent's row.
        const { chunk: c, depth, rise } = r;
        // A finished merge ("done") leaves every row on its own status.
        const mergeHere = merge && merge.status !== "done" && merge.current === c.name ? merge : undefined;
        // A chunk without a branch has no diff to show.
        const pick = onSelect && c.branch ? () => onSelect(c.name) : undefined;
        const row = clickable(pick, selected === c.name);
        // A chunk without a PR belongs to the PR of the next chunk that has one.
        const partOf = c.pr ? undefined : chunks.slice(chunks.indexOf(c) + 1).find((x) => x.pr)?.pr;
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
                  style={{ top: `calc(-50% - ${rise - 1} * 100% + 0.75rem)`, height: `calc(${rise} * 100% - 0.75rem)` }}
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
              {partOf && (
                <a
                  href={partOf}
                  target="_blank"
                  title={`Part of PR ${prLabel(partOf)}`}
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={(e) => e.stopPropagation()}>
                  in {prLabel(partOf)}
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
