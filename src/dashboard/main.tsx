import { CircleDashed, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { State } from "../state.ts";
import { Card, CardDescription, CardTitle } from "./components/ui/card";
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

function App() {
  const [pipelines, setPipelines] = useState<State[]>();
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

  const active = pipelines?.filter((p) => p.status !== "stopped").length ?? 0;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center gap-3">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold tracking-tight">pipeship</h1>
          <p className="text-sm text-muted-foreground">
            {pipelines ? `${pipelines.length} pipelines · ${active} active` : "Loading…"}
          </p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          {live ? "Live" : "Offline"}
        </span>
        <ThemeToggle />
      </header>

      {pipelines?.length === 0 && <EmptyState />}
      {pipelines?.map((p) => <PipelineCard key={p.id} p={p} />)}
      {!pipelines && (
        <div className="flex justify-center py-14 text-muted-foreground">
          <CircleDashed className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
