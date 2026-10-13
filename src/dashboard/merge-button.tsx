import { GitMerge, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import type { Chunk, MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";

const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

export function MergeButton({ id, chunks, base }: { id: string; chunks: Chunk[]; base?: string }) {
  const [error, setError] = useState<string>();
  // Merged PRs are skipped by the engine, so the dialog lists only the rest.
  const todo = chunks.filter((c) => c.pr && c.status !== "merged");
  const run = async () => {
    setError(undefined);
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/merge`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error);
  };
  return (
    <AlertDialog>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <AlertDialogTrigger asChild>
        <Button size="xs" className="bg-emerald-600 text-white hover:bg-emerald-700">
          <GitMerge /> Merge stack
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge the PR stack?</AlertDialogTitle>
          {/* asChild: a list cannot sit inside the default <p>. */}
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <ol className="flex flex-col gap-1">
                {todo.map((c) => (
                  <li key={c.name}>
                    <span className="font-medium text-foreground">#{prNumber(c.pr!)} {c.name}</span>
                    {c.branch && <code className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">{c.branch}</code>}
                  </li>
                ))}
              </ol>
              <p>
                Squash and merge, bottom first. Each next PR is rebased and retargeted to {base ?? "the base branch"}.
                Branches are kept. The merge stops at the first PR that cannot merge.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run} className="bg-emerald-600 text-white hover:bg-emerald-700">Merge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Shown on the collapsed card too: progress while it runs, the reason when it stops.
export function MergeLine({ merge }: { merge: MergeRun }) {
  if (merge.status === "done") return null;
  const where = [merge.pr && `#${merge.pr}`, merge.current].filter(Boolean).join(" ");
  const running = merge.status === "running";
  const detail = running ? merge.message : merge.error;
  return (
    <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
      {running ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <span className="min-w-0">
        {[running ? "Merging" : "Merge stopped at", where].filter(Boolean).join(" ")}
        {detail && `: ${detail}`}
      </span>
    </p>
  );
}
