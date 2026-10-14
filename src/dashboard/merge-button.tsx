import { GitMerge, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Chunk, MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { postAction, prNumber } from "./utils";

type Mode = "combine" | "base";

// Violet for every merge action: combining the stack and merging into the base. One button at a time.
const TONE = "bg-violet-600 hover:bg-violet-700 text-white";

// Shown on finished pipelines with open PRs, and while a merge runs.
// `busy`: another repo's merge runs, and only one merge runs per pipeline: the button stays, disabled.
export function MergeButton({ id, repo, chunks, base, merge, busy, finished }: {
  id: string; repo: string; chunks: Chunk[]; base?: string; merge?: MergeRun; busy: boolean; finished: boolean;
}) {
  const [error, setError] = useState<string>();
  // Like GitHub's "delete branch" offer after a merge; checked by default.
  const [deleteBranches, setDeleteBranches] = useState(true);
  // The action just clicked, until the stream reports the run (or the POST fails).
  const [starting, setStarting] = useState<Mode>();
  const todo = chunks.filter((c) => c.pr && c.status !== "merged");
  const mode: Mode = todo.length > 1 ? "combine" : "base";
  const running = merge?.status === "running";
  useEffect(() => {
    if (running) setStarting(undefined);
  }, [running]);
  const run = async () => {
    setError(undefined);
    setStarting(mode);
    const err = await postAction(id, "merge", { mode, repo, ...(mode === "base" && { deleteBranches }) });
    if (err) {
      setError(err);
      setStarting(undefined);
    }
  };
  const waitTitle = busy ? "Another repo of this pipeline is merging" : undefined;
  if (running || starting) {
    return (
      <Button size="xs" disabled className={`${TONE} disabled:opacity-80`} title={merge?.message}>
        <Loader2 className="animate-spin" /> Merging…
      </Button>
    );
  }
  if (!finished || todo.length === 0) return null;
  const failure = (error || merge?.status === "failed") && (
    <span className="flex min-w-0 items-center text-xs text-destructive" title={error ?? merge?.error}>
      <span className="max-w-72 truncate">{error ?? `Merge stopped: ${merge?.error}`}</span>
    </span>
  );
  if (mode === "combine") {
    return (
      <>
        {failure}
        <Button size="xs" className={TONE} onClick={run} disabled={busy} title={waitTitle ?? "Merge each PR into the branch below, from the top. One PR is left."}>
          <GitMerge /> Combine PRs
        </Button>
      </>
    );
  }
  const pr = todo[0]!;
  const into = base ? `Merge into ${base}` : "Merge";
  return (
    <AlertDialog>
      {failure}
      <AlertDialogTrigger asChild>
        <Button size="xs" className={TONE} disabled={busy} title={waitTitle}>
          <GitMerge /> {into}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge #{prNumber(pr.pr!)} into {base ?? "its base branch"}?</AlertDialogTitle>
          <AlertDialogDescription>Squash-merges the PR once its checks pass.</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} />
          Delete the remote branches of the stack after the merge
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run} className={TONE}>Merge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Under the branch tree, after a combine: the one PR left to merge.
export function CombinedNote({ merge, chunks }: { merge: MergeRun; chunks: Chunk[] }) {
  // Base mode: the Merged badge already says it.
  if (merge.status !== "done" || merge.mode !== "combine") return null;
  // The PR left open is the lowest one not merged.
  const left = chunks.find((c) => c.pr && c.status !== "merged")?.pr;
  if (!left) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <GitMerge className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
      <span>
        {merge.message ?? "Combined the stack"} ·{" "}
        <a href={left} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          open PR #{prNumber(left)}
        </a>
      </span>
    </p>
  );
}
