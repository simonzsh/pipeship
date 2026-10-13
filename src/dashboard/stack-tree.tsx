import { GitBranch, GitPullRequest } from "lucide-react";
import type { Chunk } from "../state.ts";
import { Button } from "./components/ui/button";
import { ChunkStatusIcon } from "./status";

// The stack is linear: each PR targets the previous one, so depth is the index (plus one under the base root).
export function StackTree({ base, chunks }: { base?: string; chunks: Chunk[] }) {
  const offset = base ? 1 : 0;
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
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
        return (
          <li key={c.name} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ paddingLeft: `calc(0.75rem + ${depth}rem)` }}>
            {/* Elbow drawn with borders: a vertical line down to the middle, then a horizontal one. */}
            {depth > 0 && <span aria-hidden className="-mt-3 h-3 w-3 shrink-0 self-center rounded-bl-sm border-b border-l border-muted-foreground/40" />}
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 whitespace-nowrap font-medium">{c.name}</span>
            {c.branch && (
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={c.branch}>
                {c.branch}
              </code>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {c.status && <ChunkStatusIcon status={c.status} />}
              {c.pr && (
                <Button asChild variant="ghost" size="sm">
                  <a href={c.pr} target="_blank">
                    <GitPullRequest /> PR
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
