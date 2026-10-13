import { CheckCircle2, GitMerge, Loader2, MessageCircleQuestion, Square, XCircle, type LucideIcon } from "lucide-react";
import type { Status } from "../state.ts";
import { Badge } from "./components/ui/badge";

type StatusConfig = {
  label: string;
  icon: LucideIcon;
  badge: string;
  halo: string;
  dot: string;
  text: string;
  group: string;
};

// One entry per status. The key order is the group order on the dashboard (most urgent first).
const STATUS: Record<Status, StatusConfig> = {
  waiting_for_user: {
    label: "Waiting for you",
    icon: MessageCircleQuestion,
    badge: "bg-amber-500/20 text-amber-800 ring-1 ring-inset ring-amber-500/40 dark:text-amber-300",
    halo: "ring-2 ring-amber-500/50 shadow-lg shadow-amber-500/20",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    group: "Waiting",
  },
  ready: {
    label: "Ready to test",
    icon: CheckCircle2,
    badge: "bg-emerald-500/20 text-emerald-800 ring-1 ring-inset ring-emerald-500/40 dark:text-emerald-300",
    halo: "ring-2 ring-emerald-500/50 shadow-lg shadow-emerald-500/20",
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
    group: "Ready for testing",
  },
  running: {
    label: "Running",
    icon: Loader2,
    badge: "bg-blue-500/20 text-blue-800 ring-1 ring-inset ring-blue-500/40 dark:text-blue-300 [&>svg]:animate-spin",
    halo: "ring-2 ring-blue-500/50 shadow-lg shadow-blue-500/20",
    dot: "bg-blue-500",
    text: "text-blue-700 dark:text-blue-400",
    group: "In progress",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    badge: "bg-red-500/20 text-red-800 ring-1 ring-inset ring-red-500/40 dark:text-red-300",
    halo: "ring-2 ring-red-500/50 shadow-lg shadow-red-500/20",
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
    group: "Failed",
  },
  stopped: {
    label: "Stopped",
    icon: Square,
    badge: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
    halo: "ring-1 ring-muted-foreground/25 shadow-sm",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    group: "Stopped",
  },
};

export const STATUS_ORDER = Object.keys(STATUS) as Status[];

// A hand-edited state.json can hold any string: fall back to the last (stopped) style.
export function statusConfig(status: string): StatusConfig {
  return STATUS[status as Status] ?? STATUS.stopped;
}

// A chunk's status is free text from the skill: "done", "pr", "merged" and "failed" are final, anything else is in progress.
// "merging" comes from the dashboard while a merge runs on that chunk: violet, so it does not look like an agent coding.
export function ChunkStatusIcon({ status, title }: { status: string; title?: string }) {
  const icon = chunkIcon(status, title ?? status);
  // A title attribute on an <svg> shows no tooltip: the wrapper carries it.
  return title ? <span title={title} className="inline-flex">{icon}</span> : icon;
}

function chunkIcon(status: string, label: string) {
  if (status === "done" || status === "pr") return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={label} />;
  if (status === "merged") return <GitMerge className="size-4 text-violet-600 dark:text-violet-400" aria-label={label} />;
  if (status === "failed") return <XCircle className="size-4 text-red-600 dark:text-red-400" aria-label={label} />;
  if (status === "merging") return <Loader2 className="size-4 animate-spin text-violet-600 dark:text-violet-400" aria-label={label} />;
  return <Loader2 className="size-4 animate-spin text-blue-600 dark:text-blue-400" aria-label={label} />;
}

export function StatusBadge({ status }: { status: Status }) {
  const { label, icon: Icon, badge } = statusConfig(status);
  return (
    <Badge variant="secondary" className={badge}>
      <Icon /> {label}
    </Badge>
  );
}
