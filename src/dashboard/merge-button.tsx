import { GitMerge, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Chunk, MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { postAction, prNumber } from "./utils";

type Mode = "combine" | "base";

// Green for a stack, violet for the last PR (a plain Merge), so the two clicks look different.
const TONE = { stack: "bg-emerald-600 hover:bg-emerald-700", single: "bg-violet-600 hover:bg-violet-700" };

// Dialog body, exported so it can be rendered without the portal.
export function MergeChoice({ todo, single, baseName, mode, onMode }: {
  todo: Chunk[]; single: boolean; baseName: string; mode: Mode; onMode: (m: Mode) => void;
}) {
  const options: { value: Mode; label: string; text: string }[] = [
    { value: "combine", label: "Combine into one PR", text: `Merges each PR into the branch below, from the top. One PR is left, targeting ${baseName}; you merge it yourself.` },
    { value: "base", label: `Merge into ${baseName}`, text: `Squash-merges every PR into ${baseName}, bottom first, rebasing and retargeting each next PR.` },
  ];
  // Combining needs at least 2 open PRs.
  const shown = single ? options.filter((o) => o.value === "base") : options;
  return (
    <>
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {todo.map((c) => (
          <li key={c.name}>
            <span className="font-medium text-foreground">#{prNumber(c.pr!)} {c.name}</span>
            {c.branch && <code className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">{c.branch}</code>}
          </li>
        ))}
      </ol>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Merge mode</legend>
        {shown.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-emerald-600 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              name="merge-mode"
              value={o.value}
              checked={mode === o.value}
              onChange={() => onMode(o.value)}
              className="mt-1 accent-emerald-600"
            />
            <span className="flex flex-col">
              <span className="font-medium text-foreground">{o.label}</span>
              <span className="text-muted-foreground">{o.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-muted-foreground">Branches are kept. The merge stops at the first PR that cannot merge.</p>
    </>
  );
}

// Shown on finished pipelines with open PRs, and while a merge runs: then the button itself shows it.
export function MergeButton({ id, chunks, base, merge, finished }: {
  id: string; chunks: Chunk[]; base?: string; merge?: MergeRun; finished: boolean;
}) {
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Mode>("combine");
  // Covers the gap between the POST and the first state update from the stream.
  const [starting, setStarting] = useState(false);
  // Merged PRs are skipped by the engine, so the dialog lists only the rest.
  const todo = chunks.filter((c) => c.pr && c.status !== "merged");
  const single = todo.length < 2;
  const mode: Mode = single ? "base" : choice;
  const baseName = base ?? "the base branch";
  const running = merge?.status === "running";
  // A combine merges PRs one by one: keep its colour while the open count drops.
  const tone = TONE[running && merge?.mode === "combine" ? "stack" : single ? "single" : "stack"];
  useEffect(() => {
    if (running) setStarting(false);
  }, [running]);
  const run = async () => {
    setError(undefined);
    setStarting(true);
    const err = await postAction(id, "merge", { mode });
    if (err) {
      setError(err);
      setStarting(false);
    }
  };
  if (running || starting) {
    const current = chunks.find((c) => c.name === merge?.current);
    const label = running ? (current?.branch ?? merge?.current) : undefined;
    return (
      <Button size="xs" disabled className={`${tone} text-white disabled:opacity-80`} title={merge?.message}>
        <Loader2 className="animate-spin" />
        <span className="max-w-64 truncate">{label ? `Merging ${label}…` : "Merging…"}</span>
      </Button>
    );
  }
  if (!finished || todo.length === 0) return null;
  return (
    <AlertDialog onOpenChange={(open) => open && setChoice("combine")}>
      {error && <span className="text-xs text-destructive">{error}</span>}
      {!error && merge && <MergeFailure merge={merge} />}
      <AlertDialogTrigger asChild>
        <Button size="xs" className={`${tone} text-white`}>
          <GitMerge /> {single ? "Merge" : "Merge stack"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{single ? `Merge #${prNumber(todo[0]!.pr!)} into ${baseName}?` : "Merge the PR stack?"}</AlertDialogTitle>
          {/* asChild: a list cannot sit inside the default <p>. */}
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-3">
              <MergeChoice todo={todo} single={single} baseName={baseName} mode={mode} onMode={setChoice} />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run} className={`${tone} text-white`}>
            {mode === "combine" ? "Combine" : `Merge into ${baseName}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Next to the button: why the last run stopped.
export function MergeFailure({ merge }: { merge: MergeRun }) {
  if (merge.status !== "failed") return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-destructive" title={merge.error}>
      <XCircle className="size-3.5 shrink-0" />
      <span className="max-w-72 truncate">Merge stopped: {merge.error}</span>
    </span>
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
