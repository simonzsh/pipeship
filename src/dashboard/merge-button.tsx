import { GitMerge, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import type { Chunk, MergeRun } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";

const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

type Mode = "combine" | "base";

// Dialog body, exported so it can be rendered without the portal.
export function MergeChoice({ todo, base, mode, onMode }: {
  todo: Chunk[]; base?: string; mode: Mode; onMode: (m: Mode) => void;
}) {
  const baseName = base ?? "the base branch";
  const options: { value: Mode; label: string; text: string }[] = [
    { value: "combine", label: "Combine into one PR", text: `Merges each PR into the branch below, from the top. One PR is left, targeting ${baseName}; you merge it yourself.` },
    { value: "base", label: `Merge into ${baseName}`, text: `Squash-merges every PR into ${baseName}, bottom first, rebasing and retargeting each next PR.` },
  ];
  // Combining needs at least 2 open PRs.
  const shown = todo.length < 2 ? options.filter((o) => o.value === "base") : options;
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
              checked={shown.length === 1 || mode === o.value}
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

export function MergeButton({ id, chunks, base }: { id: string; chunks: Chunk[]; base?: string }) {
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Mode>("combine");
  // Merged PRs are skipped by the engine, so the dialog lists only the rest.
  const todo = chunks.filter((c) => c.pr && c.status !== "merged");
  const mode: Mode = todo.length < 2 ? "base" : choice;
  const run = async () => {
    setError(undefined);
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        // The body may not be JSON (proxy error page).
        const body: { error?: string } | null = await res.json().catch(() => null);
        setError(body?.error ?? `Merge failed (${res.status})`);
      }
    } catch {
      setError("Network error: the merge did not start");
    }
  };
  return (
    <AlertDialog onOpenChange={(open) => open && setChoice("combine")}>
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
            <div className="flex flex-col gap-3">
              <MergeChoice todo={todo} base={base} mode={mode} onMode={setChoice} />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run} className="bg-emerald-600 text-white hover:bg-emerald-700">
            {mode === "combine" ? "Combine" : `Merge into ${base ?? "the base branch"}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Shown on the collapsed card too: progress while it runs, the reason when it stops.
export function MergeLine({ merge, chunks = [] }: { merge: MergeRun; chunks?: Chunk[] }) {
  if (merge.status === "done") {
    // Base mode: the Merged badge already says it.
    if (merge.mode !== "combine") return null;
    // The PR left open is the lowest one not merged.
    const left = chunks.find((c) => c.pr && c.status !== "merged")?.pr;
    return (
      <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
        <GitMerge className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="min-w-0">
          {merge.message ?? "combined the stack"}
          {left && (
            <>
              {" · "}
              <a href={left} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="underline underline-offset-2 hover:text-foreground">
                open PR #{prNumber(left)}
              </a>
            </>
          )}
        </span>
      </p>
    );
  }
  const where = [merge.pr && `#${merge.pr}`, merge.current].filter(Boolean).join(" ");
  const running = merge.status === "running";
  const detail = running ? merge.message : merge.error;
  const prefix = running ? "Merging" : where ? "Merge stopped at" : "Merge stopped";
  return (
    <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
      {running ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <span className="min-w-0">
        {where ? `${prefix} ${where}` : prefix}
        {detail && `: ${detail}`}
      </span>
    </p>
  );
}
