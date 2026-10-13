import { MoreHorizontal, Square, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
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
}

// Once the agents are done, the only things left to stop are the test servers.
const ACTIONS: Record<"stopPipeline" | "stopServer" | "delete", ActionDef> = {
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
    endpoint: "stop",
    icon: Square,
    iconClass: "text-orange-600 dark:text-orange-400",
    button: "Stop preview",
    title: "Stop the preview?",
    description: "The preview stops. The code, branches and PRs stay in place.",
    confirm: "Stop",
  },
  delete: {
    endpoint: "delete",
    icon: Trash2,
    iconClass: "text-red-600 dark:text-red-400",
    button: "Delete",
    title: "Delete this pipeline?",
    description:
      "The test servers stop, and the worktrees and pipeline files are deleted. Branches and PRs stay. Uncommitted changes block the deletion.",
    confirm: "Delete",
  },
};

type ActionName = keyof typeof ACTIONS;

// The confirmation dialog, driven from outside so a menu item can open it.
function ActionDialog({ id, action, hasServers, open, onOpenChange }: {
  id: string; action: ActionName; hasServers?: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { endpoint, title, description, serversNote, confirm } = ACTIONS[action];
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setError(await postAction(id, endpoint));
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{hasServers && serversNote ? `${description} ${serversNote}` : description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={run}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// The "⋯" menu of a pipeline: stop and delete. Renders nothing when no action applies.
export function ActionsMenu({ p, merging }: { p: State; merging: boolean }) {
  const [pending, setPending] = useState<ActionName>();
  const items: ActionName[] = [];
  if (p.status === "ready") {
    if (p.preview) items.push("stopServer");
  } else if (p.status === "running" || p.status === "waiting_for_user" || (p.status === "failed" && p.preview)) {
    items.push("stopPipeline");
  }
  if (!merging && finished(p)) items.push("delete");
  if (items.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Pipeline actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((name) => {
            const { icon: Icon, iconClass, button } = ACTIONS[name];
            return (
              <DropdownMenuItem key={name} onSelect={() => setPending(name)}>
                <Icon className={iconClass} /> {button}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && (
        <ActionDialog id={p.id} action={pending} hasServers={!!p.preview} open onOpenChange={(open) => !open && setPending(undefined)} />
      )}
    </>
  );
}
