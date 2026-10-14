import { Archive, CheckCheck, CheckCircle2, GitMerge, GitPullRequestClosed, MessageCircleQuestion, Square, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { Status } from "../state.ts";
import { Badge } from "./components/ui/badge";
import { LogoLoader } from "./logo-loader";

type StatusConfig = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge: string;
  tint: string;
  // Only on clickable cards: a deeper shade of the tint, so hover keeps the status colour.
  hover: string;
  dot: string;
  text: string;
  group: string;
};

// One entry per status. The key order is the group order on the dashboard (most urgent first). Keep "archived" last: it is the fallback.
const STATUS: Record<Status, StatusConfig> = {
  waiting_for_user: {
    label: "Waiting for you",
    icon: MessageCircleQuestion,
    badge: "bg-amber-500/20 text-amber-800 ring-1 ring-inset ring-amber-500/40 dark:text-amber-300",
    tint: "bg-amber-500/5",
    hover: "hover:bg-amber-500/10",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    group: "Waiting",
  },
  ready: {
    label: "Ready to test",
    icon: CheckCircle2,
    badge: "bg-emerald-500/20 text-emerald-800 ring-1 ring-inset ring-emerald-500/40 dark:text-emerald-300",
    tint: "bg-emerald-500/5",
    hover: "hover:bg-emerald-500/10",
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-400",
    group: "Ready for testing",
  },
  running: {
    label: "Running",
    icon: LogoLoader,
    badge: "bg-blue-500/20 text-blue-800 ring-1 ring-inset ring-blue-500/40 dark:text-blue-300",
    tint: "bg-blue-500/5",
    hover: "hover:bg-blue-500/10",
    dot: "bg-blue-500",
    text: "text-blue-700 dark:text-blue-400",
    group: "In progress",
  },
  // Green-grey: finished like "ready", but quieter because no preview runs.
  done: {
    label: "Done",
    icon: CheckCheck,
    badge: "bg-teal-700/15 text-teal-900 ring-1 ring-inset ring-teal-700/30 dark:text-teal-200",
    tint: "bg-teal-700/5",
    hover: "hover:bg-teal-700/10",
    dot: "bg-teal-700/70",
    text: "text-teal-800 dark:text-teal-300",
    group: "Done",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    badge: "bg-red-500/20 text-red-800 ring-1 ring-inset ring-red-500/40 dark:text-red-300",
    tint: "bg-red-500/5",
    hover: "hover:bg-red-500/10",
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
    group: "Failed",
  },
  stopped: {
    label: "Stopped",
    icon: Square,
    badge: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
    tint: "bg-muted/40",
    hover: "hover:bg-muted",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    group: "Stopped",
  },
  archived: {
    label: "Archived",
    icon: Archive,
    badge: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
    tint: "bg-muted/40",
    hover: "hover:bg-muted",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    group: "Archived",
  },
};

export const STATUS_ORDER = Object.keys(STATUS) as Status[];

// A hand-edited state.json can hold any string: like groupByStatus, fall back to the last status.
export function statusConfig(status: string): StatusConfig {
  return STATUS[status as Status] ?? STATUS[STATUS_ORDER[STATUS_ORDER.length - 1]!];
}

// A chunk's status is free text from the skill: "done", "merged", "closed" and "failed" are final, anything else is in progress.
// "closed" comes from the PR sync (PR closed without merge). "merging" comes from the dashboard while a merge runs on that chunk.
const NO_ACTIVITY = ["done", "merged", "closed", "failed"];

// The label next to the loader: "Coding…" at implement, "Reviewing…" and "Fixing…" at review, "Merging…" while the dashboard merges.
export function chunkActivity(status: string): string | undefined {
  if (NO_ACTIVITY.includes(status)) return undefined;
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}…`;
}

export function ChunkStatusIcon({ status, title }: { status: string; title?: string }) {
  const icon = chunkIcon(status, title ?? status);
  const activity = chunkActivity(status);
  if (activity) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={title}>
        {icon} {activity}
      </span>
    );
  }
  // A title attribute on an <svg> shows no tooltip: the wrapper carries it.
  return title ? <span title={title} className="inline-flex">{icon}</span> : icon;
}

function chunkIcon(status: string, label: string) {
  if (status === "done") return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={label} />;
  if (status === "merged") return <GitMerge className="size-4 text-violet-600 dark:text-violet-400" aria-label={label} />;
  if (status === "closed") {
    return (
      <span title="PR closed without merge" className="inline-flex">
        <GitPullRequestClosed className="size-4 text-red-600/70 dark:text-red-400/70" aria-label={label} />
      </span>
    );
  }
  if (status === "failed") return <XCircle className="size-4 text-red-600 dark:text-red-400" aria-label={label} />;
  // Violet, so a merge does not look like an agent coding.
  if (status === "merging") return <LogoLoader className="size-4 text-violet-600 dark:text-violet-400" label={label} />;
  return <LogoLoader className="size-4 text-blue-600 dark:text-blue-400" label={label} />;
}

export function StatusBadge({ status }: { status: Status }) {
  const { label, icon: Icon, badge } = statusConfig(status);
  return (
    <Badge variant="secondary" className={badge}>
      <Icon /> {label}
    </Badge>
  );
}
