import { CircleDashed, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { State } from "../state.ts";
import { Card, CardDescription, CardTitle } from "./components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { PipelineCard } from "./pipeline-card";
import { ThemeToggle } from "./theme";
import { cn } from "./utils";

function EmptyState() {
  return (
    <Card className="items-center py-14 text-center">
      <div className="rounded-full bg-muted p-3">
        <Terminal className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <CardTitle>No pipeline yet</CardTitle>
        <CardDescription>
          Run <code className="rounded bg-muted px-1.5 py-0.5">/pipeship:ship &lt;ticket&gt;</code> in Claude Code or{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">$ship &lt;ticket&gt;</code> in Codex.
        </CardDescription>
      </div>
    </Card>
  );
}

const ALL = "__all__"; // Radix forbids "" as an item value.

const shortRepo = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

function App() {
  const [pipelines, setPipelines] = useState<State[]>();
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
    for (const p of pipelines ?? []) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
    return [...counts].sort((a, b) => shortRepo(a[0]).localeCompare(shortRepo(b[0])));
  }, [pipelines]);
  // An unknown repo in the URL falls back to all repos; the URL is left as is.
  const selected = repos.some(([r]) => r === repo) ? repo : null;
  const shown = selected ? pipelines?.filter((p) => p.repo === selected) : pipelines;
  const active = shown?.filter((p) => p.status !== "stopped").length ?? 0;

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
            {shown ? `${shown.length} pipelines · ${active} active` : "Loading…"}
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {repos.length > 0 && (
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
      {shown?.map((p) => <PipelineCard key={p.id} p={p} />)}
      {!pipelines && (
        <div className="flex justify-center py-14 text-muted-foreground">
          <CircleDashed className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
