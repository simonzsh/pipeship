import {
  CheckCircle2, ChevronDown, CircleDashed, ExternalLink, FolderGit2, GitBranch, GitPullRequest, Globe, Loader2,
  MessageCircleQuestion, Square, Terminal, Trash2, XCircle, type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
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
import { TicketIcon } from "./ticket-icon";
import { cn } from "./utils";

const STATUS: Record<Status, { label: string; icon: LucideIcon; className: string }> = {
  running: { label: "Running", icon: Loader2, className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 [&>svg]:animate-spin" },
  waiting_for_user: { label: "Waiting for you", icon: MessageCircleQuestion, className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  ready: { label: "Ready to test", icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Failed", icon: XCircle, className: "bg-red-500/15 text-red-700 dark:text-red-400" },
  stopped: { label: "Stopped", icon: Square, className: "bg-muted text-muted-foreground" },
};

// "waiting" is a running step whose pipeline waits for the user: amber like the "Waiting for you" badge.
type DotStatus = StepStatus | "waiting";

const STEP_DOT: Record<DotStatus, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500 animate-pulse",
  waiting: "bg-amber-500 animate-pulse",
  failed: "bg-red-500",
  pending: "bg-muted-foreground/25",
  skipped: "border border-dashed border-muted-foreground/50",
};

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// A chunk's status is free text from the skill: "done", "pr" and "failed" are final, anything else is in progress.
function ChunkStatusIcon({ status }: { status: string }) {
  if (status === "done" || status === "pr") return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={status} />;
  if (status === "failed") return <XCircle className="size-4 text-red-600 dark:text-red-400" aria-label={status} />;
  return <Loader2 className="size-4 animate-spin text-blue-600 dark:text-blue-400" aria-label={status} />;
}

function StatusBadge({ status }: { status: Status }) {
  const { label, icon: Icon, className } = STATUS[status];
  return (
    <Badge variant="secondary" className={className}>
      <Icon /> {label}
    </Badge>
  );
}

function Steps({ steps }: { steps: { name: string; status: DotStatus }[] }) {
  // A link is green up to the furthest step reached, so skipped steps do not break the line.
  const reached = steps.findLastIndex((s) => s.status !== "pending" && s.status !== "skipped");
  return (
    <div className="grid grid-cols-7">
      {steps.map((step, i) => (
        <div key={step.name} className="relative flex flex-col items-center gap-1.5" title={`${step.name}: ${step.status}`}>
          {i < steps.length - 1 && (
            // Runs from the edge of this dot to the edge of the next one, so it never shows through a dot.
            <div
              className={cn(
                "absolute top-[5px] left-[calc(50%+10px)] h-0.5 w-[calc(100%-20px)] rounded-full",
                i < reached ? "bg-emerald-500" : "bg-muted-foreground/15",
              )}
            />
          )}
          <div className={cn("size-3 rounded-full", STEP_DOT[step.status])} />
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground capitalize",
              (step.status === "running" || step.status === "waiting") && "font-medium text-foreground",
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

// Once the agents are done, the only thing left to stop is the test server.
const ACTIONS = {
  stopPipeline: {
    endpoint: "stop",
    icon: Square,
    button: "Stop pipeline",
    title: "Stop this pipeline?",
    description: "The agents stop after their current step, and the test server stops now.",
    confirm: "Stop",
  },
  stopServer: {
    endpoint: "stop",
    icon: Square,
    button: "Stop test server",
    title: "Stop the test server?",
    description: "The test server stops. The code, branches and PRs stay in place.",
    confirm: "Stop",
  },
  delete: {
    endpoint: "delete",
    icon: Trash2,
    button: "Delete",
    title: "Delete this pipeline?",
    description:
      "The test server stops, and the worktrees and pipeline files are deleted. Branches and PRs stay. Uncommitted changes block the deletion.",
    confirm: "Delete",
  },
};

function ActionButton({ id, action }: { id: string; action: keyof typeof ACTIONS }) {
  const { endpoint, icon: Icon, button, title, description, confirm } = ACTIONS[action];
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/${endpoint}`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error);
  };
  return (
    <AlertDialog>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="xs">
          <Icon /> {button}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PipelineCard({ p }: { p: State }) {
  // Collapsed by default: the test environment and the branches only show once the card is opened.
  const [open, setOpen] = useState(false);
  const hasDetails = p.chunks.length > 0 || p.preview !== undefined;
  const detailsLabel =
    p.chunks.length === 0 ? "Details" : p.chunks.length === 1 ? "1 branch" : `${p.chunks.length} branches`;
  const steps = p.steps.map((s) => ({
    name: s.name,
    status: s.status === "running" && p.status === "waiting_for_user" ? ("waiting" as const) : s.status,
  }));
  const toggle = {
    role: "button",
    tabIndex: 0,
    "aria-expanded": open,
    onClick: () => setOpen(!open),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      setOpen(!open);
    },
  };
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* The header and the steps toggle the card. */}
      <div
        className={cn("flex flex-col gap-5 py-5", hasDetails && "cursor-pointer transition-colors hover:bg-accent")}
        {...(hasDetails && toggle)}
      >
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="truncate">{p.ticket.title}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <TicketIcon ticket={p.ticket} />
              {p.ticket.source === "text" && <span className="font-medium text-foreground">Text</span>}
              {p.ticket.links.map((link) =>
                link.url ? (
                  <a
                    key={link.ref}
                    href={link.url}
                    target="_blank"
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {link.ref}
                  </a>
                ) : (
                  <span key={link.ref} className="font-medium text-foreground">{link.ref}</span>
                ),
              )}
              <Badge variant="outline" className="text-muted-foreground">{p.mode}</Badge>
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <StatusBadge status={p.status} />
            {hasDetails && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {detailsLabel}
                <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <Steps steps={steps} />
        </CardContent>
      </div>

      {open && (
        <CardContent className="flex flex-col gap-4 border-t py-5">
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
                  <span className="shrink-0 whitespace-nowrap font-medium">{c.name}</span>
                  {c.branch && (
                    <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={c.branch}>
                      {c.branch}
                    </code>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {c.status && <ChunkStatusIcon status={c.status} />}
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
      )}

      <CardFooter className="py-3 text-xs text-muted-foreground">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="truncate font-mono" title={p.repo}>{p.repo.replace(/^\/home\/[^/]+/, "~")}</span>
        <span>·</span>
        <span className="whitespace-nowrap">updated {timeAgo(p.updatedAt)}</span>
        <div className="ml-auto flex items-center gap-2">
          {p.status === "ready" ? (
            p.preview && <ActionButton id={p.id} action="stopServer" />
          ) : p.status === "running" || p.status === "waiting_for_user" || (p.status === "failed" && p.preview) ? (
            <ActionButton id={p.id} action="stopPipeline" />
          ) : null}
          {(p.status === "ready" || p.status === "failed" || p.status === "stopped") && <ActionButton id={p.id} action="delete" />}
        </div>
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
