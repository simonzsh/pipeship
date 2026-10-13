import {
  CheckCircle2, CircleDashed, ExternalLink, FolderGit2, GitBranch, GitPullRequest, Globe, Loader2,
  MessageCircleQuestion, Square, Terminal, XCircle, type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { State, Status, StepStatus } from "../state.ts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { ThemeToggle } from "./theme";
import { cn } from "./utils";

const STATUS: Record<Status, { label: string; icon: LucideIcon; className: string }> = {
  running: { label: "Running", icon: Loader2, className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 [&>svg]:animate-spin" },
  waiting_for_user: { label: "Waiting for you", icon: MessageCircleQuestion, className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  ready: { label: "Ready to test", icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Failed", icon: XCircle, className: "bg-red-500/15 text-red-700 dark:text-red-400" },
  stopped: { label: "Stopped", icon: Square, className: "bg-muted text-muted-foreground" },
};

const STEP_BAR: Record<StepStatus, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500 animate-pulse",
  failed: "bg-red-500",
  pending: "bg-muted",
  skipped: "bg-[repeating-linear-gradient(45deg,var(--muted),var(--muted)_3px,transparent_3px,transparent_6px)]",
};

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function StatusBadge({ status }: { status: Status }) {
  const { label, icon: Icon, className } = STATUS[status];
  return (
    <Badge variant="secondary" className={className}>
      <Icon /> {label}
    </Badge>
  );
}

function Steps({ steps }: { steps: State["steps"] }) {
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {steps.map((step) => (
        <div key={step.name} className="flex flex-col gap-1.5" title={`${step.name}: ${step.status}`}>
          <div className={cn("h-1.5 rounded-full", STEP_BAR[step.status])} />
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground",
              step.status === "running" && "font-medium text-foreground",
              step.status === "skipped" && "line-through opacity-60",
            )}
          >
            {step.name}
          </span>
        </div>
      ))}
    </div>
  );
}

function StopButton({ id }: { id: string }) {
  const [error, setError] = useState<string>();
  const stop = async () => {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/stop`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error);
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <Square /> Stop pipeline
        </Button>
      </AlertDialogTrigger>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this pipeline?</AlertDialogTitle>
          <AlertDialogDescription>
            The agents stop after their current step, and the test server stops now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={stop}>Stop</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PipelineCard({ p }: { p: State }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle className="truncate">{p.ticket.title}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {p.ticket.ref &&
              (p.ticket.url ? (
                <a href={p.ticket.url} target="_blank" className="font-medium text-foreground underline-offset-4 hover:underline">
                  {p.ticket.ref}
                </a>
              ) : (
                <span className="font-medium text-foreground">{p.ticket.ref}</span>
              ))}
            <span>{p.ticket.source}</span>
            <Badge variant="outline" className="text-muted-foreground">{p.mode}</Badge>
          </CardDescription>
        </div>
        <StatusBadge status={p.status} />
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Steps steps={p.steps} />

        {p.preview && (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
            <Globe className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <a href={p.preview.url} target="_blank" className="truncate font-mono text-sm hover:underline">
              {p.preview.url}
            </a>
            <Button asChild size="sm" className="ml-auto">
              <a href={p.preview.url} target="_blank">
                Open <ExternalLink />
              </a>
            </Button>
          </div>
        )}

        {p.chunks.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border">
            {p.chunks.map((c) => (
              <li key={c.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">{c.name}</span>
                {c.branch && <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c.branch}</code>}
                <span className="ml-auto flex items-center gap-2">
                  {c.status && <Badge variant="secondary">{c.status}</Badge>}
                  {c.pr && (
                    <Button asChild variant="ghost" size="sm">
                      <a href={c.pr} target="_blank">
                        <GitPullRequest /> PR
                      </a>
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CardFooter className="text-xs text-muted-foreground">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="truncate font-mono" title={p.repo}>{p.repo.replace(/^\/home\/[^/]+/, "~")}</span>
        <span>·</span>
        <span className="whitespace-nowrap">updated {timeAgo(p.updatedAt)}</span>
        {p.status !== "stopped" && <StopButton id={p.id} />}
      </CardFooter>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="items-center py-14 text-center">
      <div className="rounded-full bg-muted p-3">
        <Terminal className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <CardTitle>No pipeline yet</CardTitle>
        <CardDescription>
          Run <code className="rounded bg-muted px-1.5 py-0.5">/pipeship &lt;ticket&gt;</code> in Claude Code.
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
