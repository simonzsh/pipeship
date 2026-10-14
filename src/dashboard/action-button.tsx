import { Archive, ArchiveRestore, Loader2, Play, Square, Trash2, type LucideIcon } from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button, buttonVariants } from "./components/ui/button";
import type { State } from "../state.ts";
import { finished } from "./pipeline-info";
import { postAction } from "./utils";

interface ActionDef {
  endpoint: string;
  icon: LucideIcon;
  iconClass: string;
  button: string;
  title: string;
  description: string;
  serversNote?: string; // appended when the pipeline has test servers
  confirm: string;
  variant?: VariantProps<typeof buttonVariants>["variant"]; // confirm button style, destructive by default
}

// Once the agents are done, the only things left to stop are the test servers.
const ACTIONS: Record<"stopPipeline" | "stopServer" | "archive" | "unarchive" | "delete", ActionDef> = {
  stopPipeline: {
    endpoint: "stop",
    icon: Square,
    iconClass: "text-orange-600 dark:text-orange-400",
    button: "Request stop",
    title: "Request a stop for this pipeline?",
    description: "The agents stop after their current step, not at once.",
    serversNote: "The test servers stop now.",
    confirm: "Request stop",
  },
  stopServer: {
    endpoint: "preview/stop",
    icon: Square,
    iconClass: "text-orange-600 dark:text-orange-400",
    button: "Stop preview",
    title: "Stop the preview?",
    description: "The preview stops. The code, branches and PRs stay in place.",
    confirm: "Stop",
    variant: "default",
  },
  archive: {
    endpoint: "archive",
    icon: Archive,
    iconClass: "text-muted-foreground",
    button: "Archive",
    title: "Archive this pipeline?",
    description: "The pipeline moves to the archived group and its preview stops. You can unarchive it later.",
    confirm: "Archive",
    variant: "default",
  },
  unarchive: {
    endpoint: "unarchive",
    icon: ArchiveRestore,
    iconClass: "text-muted-foreground",
    button: "Unarchive",
    title: "Unarchive this pipeline?",
    description: "The pipeline leaves the archived group. The preview stays stopped.",
    confirm: "Unarchive",
    variant: "default",
  },
  delete: {
    endpoint: "delete",
    icon: Trash2,
    iconClass: "text-red-600 dark:text-red-400",
    button: "Delete",
    title: "Delete this pipeline?",
    description:
      "The test servers stop, and the worktrees and pipeline files are deleted. The local branches of merged PRs are deleted too; other branches and PRs stay. Uncommitted changes block the deletion.",
    confirm: "Delete",
  },
};

type ActionName = keyof typeof ACTIONS;

// Test servers usually start at the last step: only mention them when some exist.
function ActionButton({ id, action, hasServers, disabledTitle }: { id: string; action: ActionName; hasServers?: boolean; disabledTitle?: string }) {
  const { endpoint, icon: Icon, iconClass, button, title, description, serversNote, confirm, variant } = ACTIONS[action];
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setError(await postAction(id, endpoint));
  };
  return (
    <AlertDialog>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="xs" disabled={!!disabledTitle} title={disabledTitle}>
          <Icon className={iconClass} /> {button}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{hasServers && serversNote ? `${description} ${serversNote}` : description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={variant} onClick={run}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// The stop, archive, unarchive and delete buttons of a pipeline. Renders nothing when no action applies.
export function PipelineActions({ p, merging, starting }: { p: State; merging: boolean; starting: boolean }) {
  const actions: ActionName[] = [];
  // Only agents at work can be stopped. Once they are done, a failed or done pipeline may still run its preview.
  if (p.status === "running" || p.status === "waiting_for_user") actions.push("stopPipeline");
  else if (p.preview && !starting) actions.push("stopServer");
  if (p.status === "done" || p.status === "failed" || p.status === "stopped") actions.push("archive");
  if (p.status === "archived") actions.push("unarchive");
  if (finished(p)) actions.push("delete");
  // Delete would remove the worktrees a merge runs in: it waits, disabled.
  const disabledTitle = (name: ActionName) => (name === "delete" && merging ? "Wait for the merge to end" : undefined);
  return actions.map((name) => <ActionButton key={name} id={p.id} action={name} hasServers={!!p.preview} disabledTitle={disabledTitle(name)} />);
}

// No confirm dialog: starting loses nothing. The POST returns at once, so the label follows the preview too.
export function StartPreviewButton({ id, starting }: { id: string; starting: boolean }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const run = async () => {
    setError(undefined);
    setPending(true);
    const err = await postAction(id, "preview/start");
    setError(err);
    // The live state polls every second: keep "Starting…" until it reports the start.
    if (err) setPending(false);
    else setTimeout(() => setPending(false), 1500);
  };
  const busy = pending || starting;
  return (
    <>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button variant="outline" size="xs" disabled={busy} onClick={run}>
        {busy ? <Loader2 className="animate-spin" /> : <Play className="text-emerald-600 dark:text-emerald-400" />}
        {busy ? "Starting…" : "Start preview"}
      </Button>
    </>
  );
}
