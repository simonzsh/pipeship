import { GitMerge } from "lucide-react";
import { useState } from "react";
import { CLOSED, type Chunk, type MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { LogoLoader } from "./logo-loader";
import { postAction, prNumber } from "./utils";

// Outline buttons with a violet icon, like the stop and delete actions. One button at a time.
const ICON = "text-violet-600 dark:text-violet-400";
// The dialog's confirm button stays solid violet: AlertDialogAction is red by default.
const CONFIRM = "bg-violet-600 text-white hover:bg-violet-700";

// Shown on finished pipelines with open PRs, and while a merge runs.
export function MergeButton({ id, repo, chunks, base, merge, finished }: {
  id: string; repo: string; chunks: Chunk[]; base?: string; merge?: MergeRun; finished: boolean;
}) {
  const [error, setError] = useState<string>();
  // Like GitHub's "delete branch" offer after a merge; checked by default.
  const [deleteBranches, setDeleteBranches] = useState(true);
  // The run's startedAt seen at the click (null: no click). Ends when the stream shows another run, or the POST fails.
  const [clickedAt, setClickedAt] = useState<string | undefined | null>(null);
  const todo = chunks.filter((c) => c.pr && c.status !== "merged");
  // The server refuses a stack with a closed PR: hide the button when nothing open is left, disable it otherwise.
  const closed = todo.find((c) => c.status === CLOSED);
  const running = merge?.status === "running";
  const starting = clickedAt !== null && merge?.startedAt === clickedAt;
  const run = async () => {
    setError(undefined);
    setClickedAt(merge?.startedAt);
    const err = await postAction(id, "merge", { repo, deleteBranches });
    if (err) {
      setError(err);
      setClickedAt(null);
    }
  };
  if (running || starting) {
    return (
      <Button variant="outline" size="xs" disabled title={merge?.message}>
        <LogoLoader className="size-4 text-violet-600 dark:text-violet-400" label="Merging" /> Merging…
      </Button>
    );
  }
  if (!finished || todo.every((c) => c.status === CLOSED)) return null;
  const failure = (error || merge?.status === "failed") && (
    <span className="flex min-w-0 items-center text-xs text-destructive" title={error ?? merge?.error}>
      <span className="max-w-72 truncate">{error ?? `Merge stopped: ${merge?.error}`}</span>
    </span>
  );
  const bottom = prNumber(todo[0]!.pr!);
  const target = base ?? "its base branch";
  const into = base ? `Merge into ${base}` : "Merge";
  if (closed) {
    return (
      <Button variant="outline" size="xs" disabled>
        <GitMerge className={ICON} /> {into}
      </Button>
    );
  }
  return (
    <AlertDialog>
      {failure}
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="xs">
          <GitMerge className={ICON} /> {into}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{todo.length > 1 ? `Merge ${todo.length} PRs` : `Merge #${bottom}`} into {target}?</AlertDialogTitle>
          <AlertDialogDescription>
            {todo.length > 1 ? `Combines the stack into #${bottom}, then merges it once its checks pass.` : "Merges the PR once its checks pass."}
          </AlertDialogDescription>
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
