import { Check, Copy, SquareTerminal, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { siClaude } from "simple-icons";
import type { Harness, PipelineView, Session, SessionState } from "../state.ts";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./utils";

// A flag only: the pipeline status is unchanged, and Stop and Delete stay available.
export function isSessionGone(p: PipelineView): boolean {
  const live = p.status === "running" || p.status === "waiting_for_user";
  const status = p.sessionState?.status;
  return live && (status === "stopped" || status === "archived" || status === "deleted");
}

export function resumeCommand(s: Session): string {
  const cwd = /^[\w./~-]+$/.test(s.cwd) ? s.cwd : `'${s.cwd.replace(/'/g, `'\\''`)}'`;
  return s.harness === "claude" ? `cd ${cwd} && claude --resume ${s.id}` : `cd ${cwd} && codex resume ${s.id}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// navigator.clipboard needs a secure origin; the dashboard may be open on a LAN IP.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function label(state: SessionState): string {
  if (state.status === "active") return state.activity === "busy" ? "Working" : state.activity === "idle" ? "Idle" : "Active";
  return state.status[0]!.toUpperCase() + state.status.slice(1);
}

const DOT: Record<string, string> = {
  active: "bg-emerald-500",
  loaded: "bg-emerald-500",
  deleted: "bg-red-500",
};

export function SessionGoneBadge() {
  return (
    <Badge variant="secondary" className="bg-red-500/15 text-red-700 dark:text-red-400">
      <Unplug /> Session gone
    </Badge>
  );
}

function HarnessIcon({ harness }: { harness: Harness }) {
  if (harness === "claude") {
    return (
      <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-3.5 shrink-0 text-foreground">
        <title>{siClaude.title}</title>
        <path d={siClaude.path} />
      </svg>
    );
  }
  return (
    <span title="Codex" className="flex">
      <SquareTerminal className="size-3.5 shrink-0 text-foreground" aria-label="Codex" />
    </span>
  );
}

export function SessionRow({ session, state }: { session: Session; state?: SessionState }) {
  const [copied, setCopied] = useState(false);
  const cmd = resumeCommand(session);
  // Hand-edited state may hold anything: only offer a command for a real, live session id.
  const canResume = UUID.test(session.id) && state?.status !== "deleted" && state?.status !== "unknown";
  // Reset the icon after 1.5 s; clean up if the card unmounts first.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-center gap-2 border-t px-5 py-2.5 text-xs text-muted-foreground">
      <HarnessIcon harness={session.harness} />
      <span className="font-medium capitalize text-foreground">{session.harness}</span>
      <span className="font-mono" title={session.id}>{session.id.slice(0, 8)}</span>
      {state && (
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", DOT[state.status] ?? "bg-muted-foreground/50")} />
          {label(state)}
        </span>
      )}
      {canResume && (
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          title={cmd}
          onClick={async () => {
            if (await copyText(cmd)) setCopied(true);
            else window.prompt("Copy the resume command", cmd);
          }}
        >
          {copied ? <Check /> : <Copy />} Copy resume
        </Button>
      )}
    </div>
  );
}
