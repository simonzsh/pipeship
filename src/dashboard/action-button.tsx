import { Square, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
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

// Test servers usually start at the last step: only mention them when some exist.
export function ActionButton({ id, action, hasServers }: { id: string; action: keyof typeof ACTIONS; hasServers?: boolean }) {
  const { endpoint, icon: Icon, iconClass, button, title, description, serversNote, confirm } = ACTIONS[action];
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setError(await postAction(id, endpoint));
  };
  return (
    <AlertDialog>
      {error && <span className="text-xs text-destructive">{error}</span>}
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="xs">
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
          <AlertDialogAction onClick={run}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
