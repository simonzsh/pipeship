import { Square, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";

// Once the agents are done, the only things left to stop are the test servers.
const ACTIONS = {
  stopPipeline: {
    endpoint: "stop",
    icon: Square,
    button: "Request stop",
    title: "Request a stop for this pipeline?",
    description: "The agents stop after their current step, not at once.",
    serversNote: "The test servers stop now.",
    confirm: "Request stop",
  },
  stopServer: {
    endpoint: "stop",
    icon: Square,
    button: "Stop test servers",
    title: "Stop the test servers?",
    description: "The test servers stop. The code, branches and PRs stay in place.",
    confirm: "Stop",
  },
  delete: {
    endpoint: "delete",
    icon: Trash2,
    button: "Delete",
    title: "Delete this pipeline?",
    description:
      "The test servers stop, and the worktrees and pipeline files are deleted. Branches and PRs stay. Uncommitted changes block the deletion.",
    confirm: "Delete",
  },
};

// Test servers usually start at the last step: only mention them when some exist.
export function ActionButton({ id, action, hasServers }: { id: string; action: keyof typeof ACTIONS; hasServers?: boolean }) {
  const def: { serversNote?: string } & (typeof ACTIONS)[typeof action] = ACTIONS[action];
  const { endpoint, icon: Icon, button, title, confirm } = def;
  const description = hasServers && def.serversNote ? `${def.description} ${def.serversNote}` : def.description;
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
