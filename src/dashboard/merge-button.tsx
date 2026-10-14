import { GitMerge } from "lucide-react";
import { Spinner } from "./components/ui/spinner";
import { useEffect, useState } from "react";
import type { Chunk, MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { postAction, prNumber } from "./utils";

type Mode = "combine" | "base";

// Outline buttons with a violet icon, like the stop and delete actions. One button at a time.
const ICON = "text-violet-600 dark:text-violet-400";
// The dialog's confirm button stays solid violet: AlertDialogAction is red by default.
const CONFIRM = "bg-violet-600 text-white hover:bg-violet-700";

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
      <Button variant="outline" size="xs" disabled title={merge?.message}>
        <Spinner /> Merging…
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
        <Button variant="outline" size="xs" onClick={run} disabled={busy} title={waitTitle ?? "Merge each PR into the branch below, from the top. One PR is left."}>
          <GitMerge className={ICON} /> Combine PRs
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
        <Button variant="outline" size="xs" disabled={busy} title={waitTitle}>
          <GitMerge className={ICON} /> {into}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge #{prNumber(pr.pr!)} into {base ?? "its base branch"}?</AlertDialogTitle>
          <AlertDialogDescription>Squash-merges the PR once its checks pass.</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranches} onCheckedChange={(v) => setDeleteBranches(v === true)} />
          Delete the remote branches after the merge
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="default" onClick={run} className={CONFIRM}>Merge</AlertDialogAction>
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
      <GitMerge className={`size-3.5 shrink-0 ${ICON}`} />
      <span>
        {merge.message ?? "Combined the stack"} ·{" "}
        <a href={left} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          open PR #{prNumber(left)}
        </a>
      </span>
    </p>
  );
}
