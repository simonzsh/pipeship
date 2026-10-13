import { CheckCircle2, GitMerge, Loader2, MessageCircleQuestion, Square, Unplug, XCircle, type LucideIcon } from "lucide-react";
import type { Status } from "../state.ts";
import { Badge } from "./components/ui/badge";

const STATUS: Record<Status, { label: string; icon: LucideIcon; className: string }> = {
  running: { label: "Running", icon: Loader2, className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 [&>svg]:animate-spin" },
  waiting_for_user: { label: "Waiting for you", icon: MessageCircleQuestion, className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  ready: { label: "Ready to test", icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Failed", icon: XCircle, className: "bg-red-500/15 text-red-700 dark:text-red-400" },
  stopped: { label: "Stopped", icon: Square, className: "bg-muted text-muted-foreground" },
};

// Display only: the pipeline keeps its status, so Stop and Delete work as before.
const AGENT_STOPPED = { label: "Agent stopped", icon: Unplug, className: "bg-red-500/15 text-red-700 dark:text-red-400" };

// A chunk's status is free text from the skill: "done", "pr", "merged" and "failed" are final, anything else is in progress.
export function ChunkStatusIcon({ status }: { status: string }) {
  if (status === "done" || status === "pr") return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={status} />;
  if (status === "merged") return <GitMerge className="size-4 text-violet-600 dark:text-violet-400" aria-label={status} />;
  if (status === "failed") return <XCircle className="size-4 text-red-600 dark:text-red-400" aria-label={status} />;
  return <Loader2 className="size-4 animate-spin text-blue-600 dark:text-blue-400" aria-label={status} />;
}

export function StatusBadge({ status, agentStopped }: { status: Status; agentStopped?: boolean }) {
  const { label, icon: Icon, className } = agentStopped ? AGENT_STOPPED : STATUS[status];
  return (
    <Badge variant="secondary" className={className}>
      <Icon /> {label}
    </Badge>
  );
}
