import { ChevronDown, FolderGit2, GitBranch, GitPullRequest } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { PipelineView } from "../state.ts";
import { ActionButton } from "./action-button";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { PreviewPanel } from "./preview-panel";
import { AgentLogo, isAgentStopped } from "./session";
import { ChunkStatusIcon, StatusBadge } from "./status";
import { Steps } from "./steps";
import { TicketIcon } from "./ticket-icon";
import { cn } from "./utils";

function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function PipelineCard({ p }: { p: PipelineView }) {
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
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex items-center gap-1.5">
              {p.mode === "quick" && (
                <Badge variant="secondary" className="bg-violet-500/15 text-violet-700 dark:text-violet-400">
                  Quick
                </Badge>
              )}
              <AgentLogo p={p} />
              <StatusBadge status={p.status} agentStopped={isAgentStopped(p)} />
            </div>
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
          {p.preview && <PreviewPanel preview={p.preview} />}
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
