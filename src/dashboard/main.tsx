import { ChevronDown, ChevronRight, Filter, Search, Workflow } from "lucide-react";
import { DeleteArchivedButton } from "./action-button";
import { Spinner } from "./components/ui/spinner";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardState } from "../state.ts";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./components/ui/select";
import { groupByStatus } from "./groups";
import { PipelineDetail } from "./pipeline-detail";
import { PipelineListItem } from "./pipeline-list-item";
import { STATUS_ORDER, statusConfig } from "./status";
import { matchesSearch } from "./pipeline-info";
import { SidebarFooter } from "./sidebar-footer";
import { buildSearch, parseUrl, type UrlState } from "./url";
import { cn, shortRepo } from "./utils";

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 py-14 text-center">
      <Workflow className="size-8 text-muted-foreground" />
      <div className="flex flex-col gap-2">
        <p className="font-semibold">No pipeline yet</p>
        <p className="text-sm text-muted-foreground">
          Run <code className="rounded bg-muted px-1.5 py-0.5">/pipeship:run &lt;ticket&gt;</code> in Claude Code or{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">$run &lt;ticket&gt;</code> in Codex.
        </p>
      </div>
    </div>
  );
}

const ALL = "__all__"; // Radix forbids "" as an item value.

function App() {
  const [pipelines, setPipelines] = useState<DashboardState[]>();
  const [url, setUrl] = useState<UrlState>(() => parseUrl(location.search));
  const [live, setLive] = useState(false);
  const [, tick] = useState(0);
  // Groups the user opened or closed. Archived pipelines are history: that group starts collapsed, the others open.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (status: string) => open[status] ?? status !== "archived";
  const [deleteError, setDeleteError] = useState<string>();
  const [query, setQuery] = useState("");

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
  const selected = repos.some(([r]) => r === url.repo) ? url.repo : null;
  const shown = pipelines?.filter((p) => (!selected || p.repos.some((r) => r.path === selected)) && matchesSearch(p, query));
  const groups = shown ? groupByStatus(shown, STATUS_ORDER) : [];

  // The selection follows the displayed order: groups first, then each group's items.
  const ordered = groups.flatMap((g) => g.items);
  const current = ordered.find((p) => p.id === url.p) ?? ordered[0];
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
      {!pipelines && (
        <div className="flex justify-center py-14 text-muted-foreground">
          <Spinner className="size-5" label="Loading pipelines" />
        </div>
      )}
      {pipelines?.length === 0 && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <EmptyState />
          </div>
          {/* The header is gone: the footer is the only place for the live state and the theme. */}
          <SidebarFooter live={live} />
        </>
      )}
      {pipelines && pipelines.length > 0 && (
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex w-80 shrink-0 flex-col border-r max-[899px]:w-full max-[899px]:border-r-0",
              detailOnly && "max-[899px]:hidden",
            )}
          >
            {/* The search and filter only narrow this list, so they sit on top of it and do not scroll away. */}
            <div className="flex flex-col gap-2 border-b px-3 py-3">
              <h1 className="text-sm font-semibold">Pipelines</h1>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search"
                    aria-label="Search pipelines"
                    className="h-8 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                  />
                </div>
                <Select value={selected ?? ALL} onValueChange={selectRepo}>
                  <SelectTrigger size="sm" chevron={false} className="relative w-8 shrink-0 justify-center px-0" aria-label="Filter by repo" title="Filter by repo">
                    <Filter className="size-3.5" />
                    {selected && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
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
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
              {ordered.length === 0 && <p className="px-1 text-sm text-muted-foreground">No match</p>}
              {groups.map((g) => {
                const { group, dot, text } = statusConfig(g.status);
                const collapsed = !isOpen(g.status);
                const title = (
                  <>
                    <span className={cn("size-1.5 rounded-full", dot)} />
                    <h2 className={cn("text-xs font-medium", text)}>{group} · {g.items.length}</h2>
                    <div className="h-px flex-1 bg-border" />
                  </>
                );
                return (
                  <section key={g.status} className="flex flex-col gap-1.5">
                    <div className="group/header relative flex items-center gap-2">
                      <button
                        type="button"
                        aria-expanded={!collapsed}
                        onClick={() => setOpen({ ...open, [g.status]: collapsed })}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1"
                      >
                        {collapsed ? <ChevronRight className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
                        {title}
                      </button>
                      {g.status === "archived" && <DeleteArchivedButton onResult={setDeleteError} />}
                    </div>
                    {g.status === "archived" && deleteError && <p className="px-1 text-xs text-destructive">{deleteError}</p>}
                    {!collapsed && g.items.map((p) => (
                      <PipelineListItem key={p.id} p={p} selected={p.id === current?.id} onSelect={() => selectPipeline(p.id)} />
                    ))}
                  </section>
                );
              })}
            </div>
            <SidebarFooter live={live} />
          </aside>
          <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", !detailOnly && "max-[899px]:hidden")}>
            {current && <PipelineDetail key={current.id} p={current} onBack={() => selectPipeline(null)} />}
          </main>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
