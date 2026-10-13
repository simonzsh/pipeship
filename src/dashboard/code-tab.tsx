import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Loader2, RefreshCw } from "lucide-react";
import type { DashboardState } from "../state.ts";
import { repoName } from "../repos.ts";
import type { DiffErrorBody, DiffFile, DiffHunk, DiffResponse } from "../diff.ts";
import { Button } from "./components/ui/button";
import { highlightLines, languageOf } from "./highlight";
import { diffRequests, diffUrl, type DiffRequest, type DiffTarget } from "./diff-requests";
import { prNumber } from "./utils";

export type { DiffTarget };
export interface CodeTabProps {
  p: DashboardState;
  target: DiffTarget;
  onTarget: (t: DiffTarget) => void; // the "Whole stack" breadcrumb link
}

type Result = { loading: true } | { data: DiffResponse } | { error: string };

// Refetch on manual refresh or when a chunk's branch/status changes, not on every SSE tick.
function useDiff(id: string, requests: DiffRequest[], refreshKey: string): Result[] {
  const [results, setResults] = useState<Record<string, Result>>({});
  const urls = requests.map((r) => diffUrl(id, r));
  const urlsKey = urls.join("\n");
  useEffect(() => {
    const ctl = new AbortController();
    setResults(Object.fromEntries(urls.map((u) => [u, { loading: true } as Result])));
    for (const url of urls) {
      fetch(url, { signal: ctl.signal, cache: "no-store" })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          if (ctl.signal.aborted) return;
          const r: Result =
            res.ok && Array.isArray((body as DiffResponse | null)?.files)
              ? { data: body as DiffResponse }
              : { error: (body as DiffErrorBody | null)?.error ?? `Request failed (${res.status})` };
          setResults((prev) => ({ ...prev, [url]: r }));
        })
        .catch((e) => {
          if (ctl.signal.aborted) return;
          setResults((prev) => ({ ...prev, [url]: { error: e instanceof Error ? e.message : String(e) } }));
        });
    }
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey, refreshKey]);
  return urls.map((u) => results[u] ?? { loading: true });
}

const STATUS_STYLE: Record<DiffFile["status"], string> = {
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  deleted: "bg-red-500/10 text-red-700 dark:text-red-400",
  modified: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  renamed: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  copied: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">-{deletions}</span>
    </span>
  );
}

const ROW: Record<string, string> = {
  add: "bg-emerald-500/10",
  del: "bg-red-500/10",
  context: "",
};
const GUTTER: Record<string, string> = {
  add: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  del: "bg-red-500/20 text-red-700 dark:text-red-300",
  context: "text-muted-foreground",
};
const MARK = { add: "+", del: "-", context: " " } as const;

// Old side (context + del) and new side (context + add) are highlighted as two blocks, then mapped back per line.
function HunkRows({ hunk, lang }: { hunk: DiffHunk; lang: string | undefined }) {
  const rows = useMemo(() => {
    const oldText: string[] = [];
    const newText: string[] = [];
    // Index of each line within the block of the side it is shown from.
    const pos = hunk.lines.map((l) => {
      if (l.kind !== "add") oldText.push(l.text);
      if (l.kind !== "del") newText.push(l.text);
      return (l.kind === "del" ? oldText : newText).length - 1;
    });
    const oldHl = highlightLines(oldText.join("\n"), lang);
    const newHl = highlightLines(newText.join("\n"), lang);
    return hunk.lines.map((l, i) => (l.kind === "del" ? oldHl[pos[i]!] : newHl[pos[i]!]));
  }, [hunk, lang]);
  return (
    <>
      <tr className="bg-sky-500/10 text-sky-700 dark:text-sky-300">
        <td colSpan={4} className="px-3 py-0.5 select-none">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={ROW[l.kind]}>
          <td className={`w-12 min-w-12 select-none px-2 text-right align-top tabular-nums ${GUTTER[l.kind]}`}>{l.oldNo ?? ""}</td>
          <td className={`w-12 min-w-12 select-none border-r px-2 text-right align-top tabular-nums ${GUTTER[l.kind]}`}>{l.newNo ?? ""}</td>
          <td className="w-4 select-none px-1 text-center align-top text-muted-foreground">{MARK[l.kind]}</td>
          <td className="whitespace-pre pr-4">
            {rows[i]}
            {l.noNewline && <span className="ml-2 select-none text-muted-foreground italic">No newline at end of file</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

// Folder in muted text, file name in full colour: the eye finds the file first.
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="min-w-0 truncate font-mono text-xs" title={path}>
      <span className="text-muted-foreground">{path.slice(0, cut)}</span>
      <span className="font-medium">{path.slice(cut)}</span>
    </span>
  );
}

function FileDiff({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  const lang = useMemo(() => languageOf(file.path), [file.path]);
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  return (
    <section className="border-y bg-card">
      {/* Opaque colours and no transition or blur: the old blur made the borders flicker on hover.
          Full-bleed file cards: square corners, so nothing shows through once the header sticks. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`sticky top-(--detail-header,0px) z-10 flex w-full items-center gap-2 bg-card px-6 py-2 text-left text-sm hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_4%)] ${open ? "border-b" : ""}`}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <FilePath path={renamed ? `${file.oldPath} → ${file.newPath}` : file.path} />
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[file.status]}`}>{file.status}</span>
        {file.similarity !== undefined && file.status !== "modified" && (
          <span className="shrink-0 text-xs text-muted-foreground">{file.similarity}%</span>
        )}
        <span className="ml-auto" />
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open &&
        (file.binary ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Binary file</p>
        ) : file.truncated ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            Large diff hidden ({file.additions + file.deletions} changed lines)
          </p>
        ) : file.hunks.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {file.oldMode && file.newMode ? `Mode changed ${file.oldMode} → ${file.newMode}` : "No content changes"}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-max min-w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.hunks.map((h, i) => (
                  <HunkRows key={i} hunk={h} lang={lang} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

// `all` is the last "expand/collapse all" click; it overrides every per-file choice made before it.
type All = { open: boolean; n: number } | null;

function RepoDiff({ data, all }: { data: DiffResponse; all: All }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (all) setOverrides(Object.fromEntries(data.files.map((f) => [f.path, all.open])));
  }, [all, data]);
  const isOpen = (path: string) => overrides[path] ?? true;

  if (data.files.length === 0) {
    const msg = data.truncated ? "Diff too large to show." : "No changes in this range.";
    return <p className="px-6 text-sm text-muted-foreground">{msg}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {data.truncated && (
        <p className="px-6 text-sm text-muted-foreground">Diff too large: the last files are not shown.</p>
      )}
      {data.files.map((f) => (
        <FileDiff
          key={f.path}
          file={f}
          open={isOpen(f.path)}
          onToggle={() => setOverrides((o) => ({ ...o, [f.path]: !isOpen(f.path) }))}
        />
      ))}
    </div>
  );
}

export function CodeTab({ p, target, onTarget }: CodeTabProps) {
  const [manual, setManual] = useState(0);
  const [all, setAll] = useState<All>(null);
  const requests = useMemo(() => diffRequests(p, target), [p, target]);
  // A chunk's range starts at the previous chunk, so any chunk of the repo can move it.
  const repos = new Set(requests.map((r) => r.repo));
  const refreshKey = `${manual}:${JSON.stringify(p.chunks.filter((c) => repos.has(c.repo)).map((c) => [c.branch, c.status]))}`;
  const results = useDiff(p.id, requests, refreshKey);
  const multi = p.repos.length > 1;

  const chunk = target.chunk ? p.chunks.find((c) => c.name === target.chunk) : undefined;
  const pr = chunk?.pr ? prNumber(chunk.pr) : undefined;
  const datas = results.flatMap((r) => ("data" in r ? [r.data] : []));
  const additions = datas.reduce((n, d) => n + d.additions, 0);
  const deletions = datas.reduce((n, d) => n + d.deletions, 0);
  const loading = results.some((r) => "loading" in r);
  const allOpen = all?.open ?? true;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 text-sm">
        {/* Breadcrumb: "Whole stack" is the way back once a PR is picked. */}
        {chunk ? (
          <span className="flex items-center gap-1.5">
            <button type="button" onClick={() => onTarget({})} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Whole stack
            </button>
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{`${pr ? `PR #${pr} · ` : ""}${chunk.name}`}</span>
          </span>
        ) : (
          <span className="font-medium">Whole stack</span>
        )}
        {!multi && datas[0] && <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{datas[0].range}</code>}
        {datas.length > 0 && <Counts additions={additions} deletions={deletions} />}
        {datas.length > 0 && <span className="text-xs text-muted-foreground">{datas.reduce((n, d) => n + d.files.length, 0)} files</span>}
        <span className="ml-auto flex items-center gap-2">
          {datas.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setAll((a) => ({ open: !allOpen, n: (a?.n ?? 0) + 1 }))}>
              {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />} {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setManual((n) => n + 1)} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </span>
      </div>
      {requests.length === 0 && (
        <p className="px-6 text-sm text-muted-foreground">No branch yet: nothing to compare.</p>
      )}
      {requests.map((req, i) => {
        const r = results[i]!;
        return (
          <div key={`${req.repo}:${req.chunk ?? ""}`} className="flex flex-col gap-3">
            {multi && (
              <h4 className="flex items-center gap-2 px-6 text-sm font-medium">
                {repoName(req.repo)}
                {"data" in r && <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{r.data.range}</code>}
              </h4>
            )}
            {"loading" in r ? (
              <p className="flex items-center gap-2 px-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading diff…
              </p>
            ) : "error" in r ? (
              <p className="mx-6 flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                <AlertCircle className="size-4 shrink-0" /> {r.error}
              </p>
            ) : (
              <RepoDiff data={r.data} all={all} />
            )}
          </div>
        );
      })}
    </div>
  );
}
