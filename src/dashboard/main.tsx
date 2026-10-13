import { CircleDashed, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardState } from "../state.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { groupByStatus } from "./groups";
import { PipelineDetail } from "./pipeline-detail";
import { PipelineListItem } from "./pipeline-list-item";
import { STATUS_ORDER, statusConfig } from "./status";
import { ThemeToggle } from "./theme";
import { buildSearch, parseUrl, pickSelected, type UrlState } from "./url";
import { cn, shortRepo } from "./utils";

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-14 text-center">
      <Workflow className="size-8 text-muted-foreground" />
      <div className="flex flex-col gap-2">
        <p className="font-semibold">No pipeline yet</p>
        <p className="text-sm text-muted-foreground">
          Run <code className="rounded bg-muted px-1.5 py-0.5">/pipeship:ship &lt;ticket&gt;</code> in Claude Code or{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">$ship &lt;ticket&gt;</code> in Codex.
        </p>
      </div>
    </div>
  );
}

const ALL = "__all__"; // Radix forbids "" as an item value.

function App() {
  const [pipelines, setPipelines] = useState<DashboardState[]>();
  const [url, setUrl] = useState<UrlState>(() => parseUrl(location.search));
  const repo = url.repo;
  const [live, setLive] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setLive(true);
    events.onerror = () => setLive(false);
    events.onmessage = (e) => {
      setLive(true);
      setPipelines(JSON.parse(e.data));
    };
    // Re-render now and then so "updated x min ago" stays true.
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    const onPop = () => setUrl(parseUrl(location.search));
    addEventListener("popstate", onPop);
    return () => {
      events.close();
      clearInterval(timer);
      removeEventListener("popstate", onPop);
    };
  }, []);

  const repos = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pipelines ?? []) for (const r of p.repos) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
    return [...counts].sort((a, b) => shortRepo(a[0]).localeCompare(shortRepo(b[0])));
  }, [pipelines]);
  // An unknown repo in the URL falls back to all repos; the URL is left as is.
  const selected = repos.some(([r]) => r === repo) ? repo : null;
  const shown = selected ? pipelines?.filter((p) => p.repos.some((r) => r.path === selected)) : pipelines;
  const groups = shown ? groupByStatus(shown, STATUS_ORDER) : [];
  // Only states that are present, stopped ones left out: "3 pipelines · 1 waiting for you · 2 running".
  const summary = shown
    ? [
        `${shown.length} ${shown.length === 1 ? "pipeline" : "pipelines"}`,
        ...groups
          .filter((g) => g.status !== "stopped")
          .map((g) => `${g.items.length} ${statusConfig(g.status).label.toLowerCase()}`),
      ].join(" · ")
    : "Loading…";

  // The selection follows the displayed order: groups first, then each group's items.
  const ordered = groups.flatMap((g) => g.items);
  const current = ordered.find((p) => p.id === pickSelected(ordered.map((p) => p.id), url.p));
  // On narrow screens a p in the URL shows the detail; without it, the list.
  const detailOnly = url.p !== null && current?.id === url.p;

  const selectRepo = (value: string) => {
    const next = { ...url, repo: value === ALL ? null : value };
    setUrl(next);
    history.replaceState(null, "", location.pathname + buildSearch(next));
  };
  const selectPipeline = (p: string | null) => {
    const next = { ...url, p };
    setUrl(next);
    history.pushState(null, "", location.pathname + buildSearch(next));
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-6">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold tracking-tight">pipeship</h1>
          <p className="text-sm text-muted-foreground">
            {summary}
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {pipelines && (
            <Select value={selected ?? ALL} onValueChange={selectRepo}>
              <SelectTrigger size="sm" className="min-w-0 max-w-40 sm:max-w-64" aria-label="Filter by repo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={ALL}>
                  All repos <span className="text-muted-foreground">{pipelines?.length}</span>
                </SelectItem>
                {repos.map(([r, n]) => (
                  <SelectItem key={r} value={r}>
                    {shortRepo(r)} <span className="text-muted-foreground">{n}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            {live ? "Live" : "Offline"}
          </span>
        </div>
        <ThemeToggle />
      </header>

      {!pipelines && (
        <div className="flex justify-center py-14 text-muted-foreground">
          <CircleDashed className="size-5 animate-spin" />
        </div>
      )}
      {pipelines && ordered.length === 0 && (
        <div className="overflow-y-auto px-4">
          <EmptyState />
        </div>
      )}
      {current && (
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "w-80 shrink-0 overflow-y-auto border-r px-3 py-4 max-[899px]:w-full max-[899px]:border-r-0",
              detailOnly && "max-[899px]:hidden",
            )}
          >
            <div className="flex flex-col gap-5">
              {groups.map((g) => {
                const { group, dot, text } = statusConfig(g.status);
                return (
                  <section key={g.status} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 px-1">
                      <span className={cn("size-1.5 rounded-full", dot)} />
                      <h2 className={cn("text-xs font-medium", text)}>{group} · {g.items.length}</h2>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    {g.items.map((p) => (
                      <PipelineListItem key={p.id} p={p} selected={p.id === current.id} onSelect={() => selectPipeline(p.id)} />
                    ))}
                  </section>
                );
              })}
            </div>
          </aside>
          <main className={cn("min-w-0 flex-1 overflow-y-auto", !detailOnly && "max-[899px]:hidden")}>
            <PipelineDetail key={current.id} p={current} onBack={() => selectPipeline(null)} />
          </main>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
