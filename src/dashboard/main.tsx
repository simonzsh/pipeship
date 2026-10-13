import { CircleDashed, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardState } from "../state.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { groupByStatus } from "./groups";
import { PipelineCard } from "./pipeline-card";
import { STATUS_ORDER, statusConfig } from "./status";
import { ThemeToggle } from "./theme";
import { cn } from "./utils";

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

const shortRepo = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

function App() {
  const [pipelines, setPipelines] = useState<DashboardState[]>();
  const [repo, setRepo] = useState(() => new URLSearchParams(location.search).get("repo"));
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
    return () => {
      events.close();
      clearInterval(timer);
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

  const selectRepo = (value: string) => {
    const next = value === ALL ? null : value;
    setRepo(next);
    // Keep "/" readable in the URL so a bookmarked repo stays legible.
    const query = next ? `?repo=${encodeURIComponent(next).replaceAll("%2F", "/")}` : "";
    history.replaceState(null, "", location.pathname + query);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center gap-3">
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

      {pipelines?.length === 0 && <EmptyState />}
      {groups.map((g) => {
        const { group, dot, text } = statusConfig(g.status);
        return (
          <section key={g.status} className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <span className={cn("size-2 rounded-full", dot)} />
              <h2 className={cn("text-sm font-medium", text)}>{group} · {g.items.length}</h2>
              <div className="h-px flex-1 bg-border" />
            </div>
            {g.items.map((p) => <PipelineCard key={p.id} p={p} />)}
          </section>
        );
      })}
      {!pipelines && (
        <div className="flex justify-center py-14 text-muted-foreground">
          <CircleDashed className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
