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
  // A refused "Merge now", tied to its run: it must not hide the reason of a run that ended since.
  const [forceError, setForceError] = useState<{ run: string; message: string }>();
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
  const alert = (message: string | undefined) =>
    message && (
      <span className="flex min-w-0 items-center text-xs text-destructive" title={message}>
        <span className="max-w-72 truncate">{message}</span>
      </span>
    );
  const force = async () => {
    const run = merge!.startedAt;
    setForceError(undefined);
    const err = await postAction(id, "merge", { repo, force: true });
    if (err) setForceError({ run, message: err });
  };
  if (running || starting) {
    const pr = todo[0]?.pr;
    const merging = (
      <Button variant="outline" size="xs" disabled title={running ? merge.message : undefined}>
        <LogoLoader className="size-4 text-violet-600 dark:text-violet-400" label="Merging" /> Merging…
      </Button>
    );
    const forceAlert = running && forceError?.run === merge.startedAt && alert(forceError.message);
    // While the checks run, the one button opens the "Merge now" choice instead of staying disabled.
    if (!running || !pr || !merge.waitingChecks || merge.force) {
      return (
        <>
          {forceAlert}
          {merging}
        </>
      );
    }
    return (
      <AlertDialog>
        {forceAlert}
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="xs" title={merge.message}>
            <LogoLoader className="size-4 text-violet-600 dark:text-violet-400" label="Waiting for checks" /> Checks pending
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge #{prNumber(pr)} now?</AlertDialogTitle>
            <AlertDialogDescription>
              Merges right away with <code>--admin</code>, without waiting for the checks.{" "}
              <a href={`${pr}/checks`} target="_blank" rel="noreferrer" className="underline hover:text-foreground">See the checks</a>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep waiting</AlertDialogCancel>
            <AlertDialogAction variant="default" onClick={force} className={CONFIRM}>Merge now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  // The server refuses a closed PR and a stack of 2 or more: hide the button when only closed PRs are left,
  // disable it for a stack (a closed PR among 2 or more is a stack too).
  if (!finished || todo.every((c) => c.status === CLOSED)) return null;
  const failure = alert(refusal ?? error ?? (merge?.status === "failed" ? `Merge stopped: ${merge.error}` : undefined));
  const button = (
    <Button variant="outline" size="xs" disabled={!!refusal} title={refusal}>
      <GitMerge className={ICON} /> Merge
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
