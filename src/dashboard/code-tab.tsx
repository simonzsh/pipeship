import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertCircle, ArrowUp, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FlaskConical, FlaskConicalOff, Folder, RefreshCw } from "lucide-react";
import { Spinner } from "./components/ui/spinner";
import type { DashboardState } from "../state.ts";
import { chunksOf, holdingPr, repoName } from "../repos.ts";
import type { DiffErrorBody, DiffFile, DiffHunk, DiffResponse, LineKind } from "../diff.ts";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { highlightLines, languageOf } from "./highlight";
import { diffRequests, diffUrl, type DiffRequest, type DiffTarget } from "./diff-requests";
import { buildFileTree, fileDomId, type TreeNode } from "./file-tree";
import { isTestFile } from "./test-files";
import { prNumber } from "./utils";

export type { DiffTarget };
export interface CodeTabProps {
  p: DashboardState;
  target: DiffTarget;
  onTarget: (t: DiffTarget) => void; // the "Whole repo" breadcrumb link
}

type Result = { loading: true } | { data: DiffResponse } | { error: string };

export interface RefreshKeys {
  manual: number; // Refresh button: forces the server fetch
  soft: string; // branch/status changed: goes through the server cache
}

// Stale-while-revalidate: each URL keeps its last result and shows it while a refetch runs.
// Refetch on manual refresh or a branch/status change, not on every SSE tick.
function useDiff(id: string, requests: DiffRequest[], keys: RefreshKeys): { results: Result[]; fetching: boolean } {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [fetching, setFetching] = useState(false);
  const lastManual = useRef(keys.manual);
  const urls = requests.map((r) => diffUrl(id, r));
  const urlsKey = urls.join("\n");
  useEffect(() => {
    const force = keys.manual !== lastManual.current;
    lastManual.current = keys.manual;
    const ctl = new AbortController();
    setFetching(true);
    // An old error must not stick: the revalidation below replaces it.
    setResults((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => "data" in v)));
    let pending = urls.length;
    const done = () => {
      if (--pending === 0 && !ctl.signal.aborted) setFetching(false);
    };
    if (pending === 0) setFetching(false);
    for (const [i, url] of urls.entries()) {
      fetch(force ? diffUrl(id, requests[i]!, true) : url, { signal: ctl.signal, cache: "no-store" })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          if (ctl.signal.aborted) return;
          const r: Result =
            res.ok && Array.isArray((body as DiffResponse | null)?.files)
              ? { data: body as DiffResponse }
              : { error: (body as DiffErrorBody | null)?.error ?? `Request failed (${res.status})` };
          setResults((prev) => ({ ...prev, [url]: r }));
          done();
        })
        .catch((e) => {
          if (ctl.signal.aborted) return;
          setResults((prev) => ({ ...prev, [url]: { error: e instanceof Error ? e.message : String(e) } }));
          done();
        });
    }
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey, keys.manual, keys.soft]);
  // Stable identity between renders: the tree and its scroll tracking depend on it.
  const list = useMemo(() => urls.map((u) => results[u] ?? ({ loading: true } as Result)), [results, urlsKey]);
  return { results: list, fetching };
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

const ROW: Record<LineKind, string> = {
  add: "bg-emerald-500/10",
  del: "bg-red-500/10",
  context: "",
};
const GUTTER: Record<LineKind, string> = {
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

// Line height of the diff table (leading-5): the placeholder keeps the page height before render.
const LINE_PX = 20;
const MARGIN_PX = 1500;

// Renders its children only once near the viewport, then keeps them: a big diff paints in slices.
function WhenVisible({ lines, children }: { lines: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  // Layout effect: files already near the screen render before the first paint.
  // The observer fires a frame later, which made the diff blink on a branch switch.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight + MARGIN_PX && r.bottom > -MARGIN_PX) return setSeen(true);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setSeen(true);
      io.disconnect();
    }, { rootMargin: `${MARGIN_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return seen ? children : <div ref={ref} style={{ height: lines * LINE_PX }} />;
}

const FileDiff = memo(function FileDiff({ id, file, open, onToggle }: { id: string; file: DiffFile; open: boolean; onToggle: (path: string, open: boolean) => void }) {
  const lang = useMemo(() => languageOf(file.path), [file.path]);
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  return (
    <section id={id} data-diff-file className="mx-6 overflow-clip rounded-lg border bg-card lg:ml-0">
      {/* Opaque colours and no transition or blur: the old blur made the borders flicker on hover.
          The card clips its corners, not the header: a stuck header stays square, so nothing shows through. */}
      <button
        type="button"
        onClick={() => onToggle(file.path, open)}
        aria-expanded={open}
        className={`sticky top-(--bar) z-10 flex w-full items-center gap-2 bg-card px-4 py-2 text-left text-sm hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_4%)] ${open ? "border-b" : ""}`}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <FilePath path={renamed ? `${file.oldPath} → ${file.newPath}` : file.path} />
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[file.status]}`}>{file.status}</span>
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
          <WhenVisible lines={file.hunks.reduce((n, h) => n + h.lines.length + 1, 0)}>
            <div className="overflow-x-auto">
              <table className="w-max min-w-full border-collapse font-mono text-xs leading-5">
                <tbody>
                  {file.hunks.map((h, i) => (
                    <HunkRows key={i} hunk={h} lang={lang} />
                  ))}
                </tbody>
              </table>
            </div>
          </WhenVisible>
        ))}
    </section>
  );
});

// `all` is the last "expand/collapse all" click; it overrides every per-file choice made before it.
type All = { open: boolean } | null;

// Like GitHub, a big file starts closed, and files stop opening once the diff passes a line budget.
const LARGE_FILE = 400;
const OPEN_BUDGET = 3000;

function openByDefault(files: DiffFile[]): Set<string> {
  const open = new Set<string>();
  let budget = OPEN_BUDGET;
  for (const f of files) {
    const n = f.additions + f.deletions;
    if (n > LARGE_FILE || n > budget) continue;
    open.add(f.path);
    budget -= n;
  }
  return open;
}

// A tree click: `seq` makes a second click on the same file count as a new request.
interface Reveal {
  repo: string;
  path: string;
  seq: number;
}

// memo: each pipeline change on the SSE stream re-renders CodeTab; the diff must not re-render with it.
const RepoDiff = memo(function RepoDiff({ data, all, tests, reveal }: { data: DiffResponse; all: All; tests: All; reveal: Reveal | null }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Layout effect: the file is open before the scroll that CodeTab runs on the next frame.
  useLayoutEffect(() => {
    if (reveal) setOverrides((o) => ({ ...o, [reveal.path]: true }));
  }, [reveal]);
  useEffect(() => {
    if (all) setOverrides(Object.fromEntries(data.files.map((f) => [f.path, all.open])));
  }, [all, data]);
  // Apply each tests click once, so a refetch does not re-close files the user opened.
  const doneTests = useRef<All>(null);
  useEffect(() => {
    if (!tests || tests === doneTests.current) return;
    doneTests.current = tests;
    const testFiles = data.files.filter((f) => isTestFile(f.path));
    if (testFiles.length) setOverrides((o) => ({ ...o, ...Object.fromEntries(testFiles.map((f) => [f.path, tests.open])) }));
  }, [tests, data]);
  const defaults = useMemo(() => openByDefault(data.files), [data]);
  const toggle = useCallback((path: string, open: boolean) => setOverrides((o) => ({ ...o, [path]: !open })), []);

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
          id={fileDomId(data.repo, f.path)}
          file={f}
          open={overrides[f.path] ?? defaults.has(f.path)}
          onToggle={toggle}
        />
      ))}
    </div>
  );
});

interface TreeSection {
  repo: string;
  files: DiffFile[];
}

const STATUS_LETTER: Record<DiffFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

function TreeRows({ nodes, depth, repo, active, closed, onFold, onSelect }: {
  nodes: TreeNode[];
  depth: number;
  repo: string;
  active: string | null;
  closed: Set<string>;
  onFold: (key: string) => void;
  onSelect: (repo: string, path: string) => void;
}) {
  return nodes.map((n) => {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (n.kind === "dir") {
      const key = `${repo}\0${n.path}`;
      const shut = closed.has(key);
      return (
        <div key={key}>
          <button type="button" onClick={() => onFold(key)} aria-expanded={!shut} style={pad} className="flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left text-xs hover:bg-muted">
            {shut ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono" title={n.path}>{n.name}</span>
          </button>
          {!shut && <TreeRows nodes={n.children} depth={depth + 1} repo={repo} active={active} closed={closed} onFold={onFold} onSelect={onSelect} />}
        </div>
      );
    }
    const f = n.file;
    const renamed = f.oldPath && f.newPath && f.oldPath !== f.newPath;
    const current = active === fileDomId(repo, n.path);
    return (
      <button
        key={n.path}
        type="button"
        onClick={() => onSelect(repo, n.path)}
        title={renamed ? `${f.oldPath} → ${f.newPath}` : n.path}
        aria-current={current || undefined}
        style={{ paddingLeft: 8 + depth * 12 + 18 }}
        className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-xs hover:bg-muted ${current ? "bg-accent" : ""}`}
      >
        <span className={`shrink-0 rounded px-1 font-mono text-[10px] font-medium ${STATUS_STYLE[f.status]}`}>{STATUS_LETTER[f.status]}</span>
        <span className="min-w-0 truncate font-mono font-medium">{n.name}</span>
        <span className="ml-auto" />
        <Counts additions={f.additions} deletions={f.deletions} />
      </button>
    );
  });
}

// One tree for all repos: with several, each repo is a root node. Hidden on narrow screens.
function FileTree({ sections, multi, active, onSelect }: { sections: TreeSection[]; multi: boolean; active: string | null; onSelect: (repo: string, path: string) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const onFold = useCallback((key: string) => setClosed((c) => {
    const next = new Set(c);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const trees = useMemo(() => sections.map((s) => ({ repo: s.repo, nodes: buildFileTree(s.files) })), [sections]);
  return (
    <nav aria-label="Changed files" className="sticky top-[calc(var(--bar)+0.75rem)] ml-6 hidden max-h-[calc(100vh-10rem-var(--bar))] w-72 shrink-0 self-start overflow-y-auto rounded-lg border bg-card p-1 lg:block">
      {trees.map(({ repo, nodes }) => {
        const key = `${repo}\0`;
        const shut = closed.has(key);
        return (
          <div key={repo}>
            {multi && (
              <button type="button" onClick={() => onFold(key)} aria-expanded={!shut} className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-left text-xs font-medium hover:bg-muted">
                {shut ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 truncate">{repoName(repo)}</span>
              </button>
            )}
            {!shut && <TreeRows nodes={nodes} depth={multi ? 1 : 0} repo={repo} active={active} closed={closed} onFold={onFold} onSelect={onSelect} />}
          </div>
        );
      })}
    </nav>
  );
}

// Warns when the diff shows work the PR on GitHub does not have yet.
function OriginSync({ data }: { data: DiffResponse }) {
  const o = data.origin;
  const commits = (n: number) => `${n} commit${n > 1 ? "s" : ""}`;
  const text = [o?.ahead && `${commits(o.ahead)} not pushed`, o?.behind && `${commits(o.behind)} behind origin`].filter(Boolean).join(", ");
  if (!text) return null;
  return (
    <Badge variant="secondary" title={`Local ${data.to} against origin/${data.to}`} className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
      {text}
    </Badge>
  );
}

// The diff scrolls inside the detail pane: its first scrollable ancestor.
function scrollPane(from: HTMLElement | null): HTMLElement | null {
  let el = from?.parentElement ?? null;
  while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
  return el;
}

// Sticky corner button, shown once the pane is scrolled down.
function ScrollTop({ root }: { root: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState(false);
  const pane = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = scrollPane(root.current);
    pane.current = el;
    if (!el) return;
    const on = () => setShown(el.scrollTop > 400);
    on();
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [root]);
  if (!shown) return null;
  return (
    <Button
      size="icon"
      variant="outline"
      aria-label="Scroll to top"
      title="Scroll to top"
      className="sticky bottom-4 z-20 mr-4 -mt-10 self-end bg-card shadow-md dark:bg-card dark:hover:bg-accent"
      onClick={() => pane.current?.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <ArrowUp />
    </Button>
  );
}

const USER_SCROLL = ["wheel", "touchstart", "keydown", "mousedown"] as const;

export function CodeTab({ p, target, onTarget }: CodeTabProps) {
  const root = useRef<HTMLDivElement>(null);
  const [manual, setManual] = useState(0);
  const [all, setAll] = useState<All>(null);
  const [tests, setTests] = useState<All>(null);
  const requests = useMemo(() => diffRequests(p, target), [p, target]);
  // A chunk's range starts at the previous chunk, so any chunk of the repo can move it.
  const repos = new Set(requests.map((r) => r.repo));
  const mine = p.chunks.filter((c) => repos.has(c.repo));
  const keys = { manual, soft: JSON.stringify(mine.map((c) => [c.branch, c.status])) };
  const { results, fetching } = useDiff(p.id, requests, keys);
  const multi = p.repos.length > 1;
  const [active, setActive] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const seq = useRef(0);
  // While a tree click scrolls, the scroll tracking must not replace the clicked file.
  const lockUntil = useRef(0);
  const sections = useMemo(
    () => results.flatMap((r) => ("data" in r && r.data.files.length ? [{ repo: r.data.repo, files: r.data.files }] : [])),
    [results],
  );
  // The toolbar sticks at the pane top and wraps on narrow panes: share its height through `--bar`.
  const bar = useRef<HTMLDivElement>(null);
  const barHeight = () => bar.current?.offsetHeight ?? 0;
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => root.current?.style.setProperty("--bar", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const select = useCallback((repo: string, path: string) => {
    setActive(fileDomId(repo, path));
    lockUntil.current = performance.now() + 500;
    setReveal({ repo, path, seq: ++seq.current });
  }, []);

  useEffect(() => {
    if (!reveal) return;
    const pane = scrollPane(root.current);
    if (!pane) return;
    // Lazy sections near the target grow once rendered: re-align until it holds still, or until the user scrolls.
    let raf = 0;
    let frames = 0;
    let still = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const e of USER_SCROLL) pane.removeEventListener(e, stop);
    };
    const align = () => {
      const el = document.getElementById(fileDomId(reveal.repo, reveal.path));
      if (!el) return stop();
      // The file header sticks under the toolbar: aligning the section top there keeps it visible.
      const delta = el.getBoundingClientRect().top - pane.getBoundingClientRect().top - barHeight();
      if (Math.abs(delta) > 1) {
        pane.scrollTo({ top: pane.scrollTop + delta });
        still = 0;
      } else still++;
      lockUntil.current = performance.now() + 200;
      if (still < 3 && ++frames < 60) raf = requestAnimationFrame(align);
      else stop();
    };
    for (const e of USER_SCROLL) pane.addEventListener(e, stop, { passive: true });
    raf = requestAnimationFrame(align);
    return stop;
  }, [reveal]);

  // The highlighted file is the last one whose top has passed the top of the pane.
  useEffect(() => {
    const pane = scrollPane(root.current);
    if (!pane || sections.length === 0) return;
    const track = () => {
      if (performance.now() < lockUntil.current) return;
      const top = pane.getBoundingClientRect().top + barHeight() + 4;
      const els = root.current?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? [];
      let id = els[0]?.id ?? null;
      for (const el of els) if (el.getBoundingClientRect().top <= top) id = el.id;
      setActive(id);
    };
    track();
    pane.addEventListener("scroll", track, { passive: true });
    return () => pane.removeEventListener("scroll", track);
  }, [sections]);

  const chunk = target.chunk ? p.chunks.find((c) => c.name === target.chunk) : undefined;
  const held = chunk ? holdingPr(chunksOf(p, chunk.repo), chunk.name) : undefined;
  const pr = held ? prNumber(held) : undefined;
  const datas = results.flatMap((r) => ("data" in r ? [r.data] : []));
  const additions = datas.reduce((n, d) => n + d.additions, 0);
  const deletions = datas.reduce((n, d) => n + d.deletions, 0);
  const allOpen = all?.open ?? true;
  const testsOpen = tests?.open ?? true;
  const hasTests = datas.some((d) => d.files.some((f) => isTestFile(f.path)));

  return (
    <div ref={root} className="flex flex-col gap-4 [--bar:0px]">
      <div ref={bar} className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-6 py-2 text-sm">
        {/* Breadcrumb: "Whole repo" is the way back once a chunk is picked. */}
        {chunk ? (
          <span className="flex items-center gap-1.5">
            <button type="button" onClick={() => onTarget({})} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Whole repo
            </button>
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{`${pr ? `PR #${pr} · ` : ""}${chunk.name}`}</span>
          </span>
        ) : (
          <span className="font-medium">Whole repo</span>
        )}
        {!multi && datas[0] && <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{datas[0].range}</code>}
        {!multi && datas[0] && <OriginSync data={datas[0]} />}
        {datas.length > 0 && <Counts additions={additions} deletions={deletions} />}
        {datas.length > 0 && <span className="text-xs text-muted-foreground">{datas.reduce((n, d) => n + d.files.length, 0)} files</span>}
        <span className="ml-auto flex items-center gap-2">
          {datas.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Expand/collapse all moves the test files too: keep the tests button in step.
                setAll({ open: !allOpen });
                setTests({ open: !allOpen });
              }}
            >
              {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />} {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          )}
          {hasTests && (
            <Button size="sm" variant="outline" onClick={() => setTests({ open: !testsOpen })} title={testsOpen ? "Collapse test files" : "Expand test files"}>
              {testsOpen ? <FlaskConicalOff /> : <FlaskConical />} {testsOpen ? "Collapse tests" : "Expand tests"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setManual((n) => n + 1)} disabled={fetching}>
            {fetching ? <Spinner /> : <RefreshCw />} Refresh
          </Button>
        </span>
      </div>
      {requests.length === 0 && (
        <p className="px-6 text-sm text-muted-foreground">No branch yet: nothing to compare.</p>
      )}
      <div className="flex items-start gap-4">
        {sections.length > 0 && <FileTree sections={sections} multi={multi} active={active} onSelect={select} />}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {requests.map((req, i) => {
            const r = results[i]!;
            return (
              <div key={`${req.repo}:${req.chunk ?? ""}`} className="flex flex-col gap-3">
                {multi && (
                  <h4 className="flex items-center gap-2 px-6 text-sm font-medium">
                    {repoName(req.repo)}
                    {"data" in r && <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{r.data.range}</code>}
                    {"data" in r && <OriginSync data={r.data} />}
                  </h4>
                )}
                {"loading" in r ? (
                  <p className="flex items-center gap-2 px-6 text-sm text-muted-foreground">
                    <Spinner className="size-4" /> Loading diff…
                  </p>
                ) : "error" in r ? (
                  <p className="mx-6 flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                    <AlertCircle className="size-4 shrink-0" /> {r.error}
                  </p>
                ) : (
                  <RepoDiff data={r.data} all={all} tests={tests} reveal={reveal?.repo === r.data.repo ? reveal : null} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ScrollTop root={root} />
    </div>
  );
}
