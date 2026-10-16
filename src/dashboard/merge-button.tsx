import { GitMerge } from "lucide-react";
import { useState } from "react";
import { CLOSED, openPrChunks, stackRefusal } from "../repos.ts";
import type { Chunk, MergeRun } from "../state.ts";
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
  const todo = openPrChunks(chunks);
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
  const refusal = todo.length > 1 ? stackRefusal(repo, todo.length) : undefined;
  const message = refusal ?? error ?? (!running && merge?.status === "failed" ? `Merge stopped: ${merge.error}` : undefined);
  const failure = message && (
    <span className="flex min-w-0 items-center text-xs text-destructive" title={message}>
      <span className="max-w-72 truncate">{message}</span>
    </span>
  );
  const force = async () => {
    setError(undefined);
    const err = await postAction(id, "merge", { repo, force: true });
    if (err) setError(err);
  };
  if (running || starting) {
    const pr = todo[0]?.pr;
    return (
      <>
        {failure}
        {running && (
          <span className="max-w-72 truncate text-xs text-muted-foreground" title={merge.message}>{merge.message}</span>
        )}
        {running && pr && (
          <a href={`${pr}/checks`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline hover:text-foreground">Checks</a>
        )}
        {running && pr && merge.waitingChecks && !merge.force && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="xs"><GitMerge className={ICON} /> Merge now</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Merge #{prNumber(pr)} now?</AlertDialogTitle>
                <AlertDialogDescription>
                  Stops waiting for the pending checks and merges with `gh pr merge --admin`. This bypasses the required checks and
                  branch protection, and needs admin rights on the repo. A failed check still stops the merge.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="default" onClick={force} className={CONFIRM}>Merge now</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button variant="outline" size="xs" disabled>
          <LogoLoader className="size-4 text-violet-600 dark:text-violet-400" label="Merging" /> Merging…
        </Button>
      </>
    );
  }
  // The server refuses a closed PR and a stack of 2 or more: hide the button when only closed PRs are left,
  // disable it for a stack (a closed PR among 2 or more is a stack too).
  if (!finished || todo.every((c) => c.status === CLOSED)) return null;
  const button = (
    <Button variant="outline" size="xs" disabled={!!refusal} title={refusal}>
      <GitMerge className={ICON} /> {base ? `Merge into ${base}` : "Merge"}
    </Button>
  );
  if (refusal) {
    return (
      <>
        {failure}
        {button}
      </>
    );
  }
  return (
    <AlertDialog>
      {failure}
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Merge #{prNumber(todo[0]!.pr!)} into {base ?? "its base branch"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Merges the PR once its checks pass.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={deleteBranches} onCheckedChange={(v) => setDeleteBranches(v === true)} />
          Delete the PR's remote branch after the merge
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="default" onClick={run} className={CONFIRM}>Merge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
