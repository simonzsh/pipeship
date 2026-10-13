import { GitBranch, GitPullRequest, Loader2, XCircle } from "lucide-react";
import type { Chunk, MergeRun } from "../state.ts";
import { Button } from "./components/ui/button";
import { ChunkStatusIcon } from "./status";

// "#12" for a GitHub PR URL; other hosts keep the plain label.
const prLabel = (url: string) => {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `#${n}` : "PR";
};

// The stack is linear: each PR targets the previous one, so depth is the index (plus one under the base root).
export function StackTree({ base, chunks, merge }: { base?: string; chunks: Chunk[]; merge?: MergeRun }) {
  const offset = base ? 1 : 0;
  return (
    <ul className="flex flex-col rounded-lg border">
      {base && (
        <li className="flex items-center gap-3 px-3 py-2 text-sm">
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
        return (
          <li key={c.name} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ paddingLeft: depth > 0 ? `calc(0.75rem + ${depth - 1} * 1.75rem)` : undefined }}>
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
              {mergeHere?.status === "running" ? (
                <Loader2 className="size-4 animate-spin text-blue-600 dark:text-blue-400" aria-label="merging" />
              ) : mergeHere?.status === "failed" ? (
                <XCircle className="size-4 text-red-600 dark:text-red-400" aria-label="merge stopped" role="img">
                  <title>{mergeHere.error}</title>
                </XCircle>
              ) : (
                c.status && <ChunkStatusIcon status={c.status} />
              )}
              {c.pr && (
                <Button asChild variant="ghost" size="sm">
                  <a href={c.pr} target="_blank">
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
