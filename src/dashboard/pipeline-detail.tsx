import { ArrowLeft, FolderGit2, GitMerge, Loader2, Zap } from "lucide-react";
import { useState } from "react";
import { repoName, repoStacks } from "../repos.ts";
import type { DashboardState } from "../state.ts";
import { ActionButton } from "./action-button";
import { CodeTab, type DiffTarget } from "./code-tab";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { CombinedNote, MergeButton } from "./merge-button";
import { allMerged, displaySteps, finished, timeAgo } from "./pipeline-info";
import { PreviewPanel } from "./preview-panel";
import { AgentLogo, T3ThreadButton } from "./session";
import { StackTree } from "./stack-tree";
import { StatusBadge, statusConfig } from "./status";
import { Steps } from "./steps";
import { TestGuide } from "./test-guide";
import { TicketIcon } from "./ticket-icon";
import { cn, shortRepo } from "./utils";

export function PipelineDetail({ p, onBack }: { p: DashboardState; onBack: () => void }) {
  const [target, setTarget] = useState<DiffTarget>({});
  const hasTest = p.preview !== undefined || !!p.testGuide;
  const [tab, setTab] = useState(hasTest ? "test" : "code");
  const stacks = repoStacks(p);
  const multi = p.repos.length > 1;
  // One merge runs per pipeline: the other repos' buttons hide meanwhile.
  const busyFor = (path: string) => p.merge?.status === "running" && p.merge.repo !== path;
  const merging = p.merge?.status === "running";
  const done = finished(p);
  const repoLabel =
    p.repos.length === 0 ? "" : multi ? stacks.map((st) => st.name).join(" + ") : shortRepo(p.repos[0]!.path);
  const showTicket = p.ticket.links.length > 0 || (p.ticket.source && p.ticket.source !== "text");
  const select = (t: DiffTarget) => {
    setTarget(t);
    setTab("code");
  };
  // The tree of one repo's stack, or a hint when it has no branch yet.
  const tree = (base: string | undefined, chunks: DashboardState["chunks"], merge: DashboardState["merge"]) => (
    <>
      {chunks.length > 0 ? (
        <StackTree base={base} chunks={chunks} merge={merge} selected={target.chunk} onSelect={(chunk) => select({ chunk })} onSelectBase={() => select({})} />
      ) : (
        <p className="text-xs text-muted-foreground">No branch yet</p>
      )}
      {merge && <CombinedNote merge={merge} chunks={chunks} />}
    </>
  );
  // Same layout for one repo or several: the repo row carries its merge button.
  const stack =
    stacks.length === 0 ? (
      <p className="text-xs text-muted-foreground">No branch yet</p>
    ) : (
      stacks.map((st) => (
        <div key={st.repo.path} className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{st.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground" title={st.repo.path}>
              {shortRepo(st.repo.path)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <MergeButton
                id={p.id} repo={st.repo.path} chunks={st.chunks} base={st.repo.base} merge={st.merge}
                busy={busyFor(st.repo.path)} finished={done}
              />
            </div>
          </div>
          {tree(st.repo.base, st.chunks, st.merge)}
        </div>
      ))
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No status tint here: the list already carries the colour, the detail stays calm. */}
      <div className="flex flex-col gap-4 border-b bg-background px-6 py-5">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 hidden w-fit max-[899px]:inline-flex">
          <ArrowLeft /> Pipelines
        </Button>
        <div className="flex items-start justify-between gap-4 max-[599px]:flex-col">
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="text-lg font-semibold leading-tight">{p.ticket.title}</h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusBadge status={p.status} />
              {p.mode === "quick" && (
                <Badge variant="secondary" className="bg-pink-500/15 text-pink-700 dark:text-pink-400">
                  <Zap /> Quick
                </Badge>
              )}
              {allMerged(p) && (
                <Badge variant="secondary" className="bg-violet-500/15 text-violet-700 dark:text-violet-400">
                  <GitMerge /> Merged
                </Badge>
              )}
              {/* A plain-text ticket has no link to show. */}
              {showTicket && (
                <span className="flex items-center gap-1.5 text-sm">
                  <TicketIcon ticket={p.ticket} />
                  {p.ticket.links.map((link) =>
                    link.url ? (
                      <a key={link.ref} href={link.url} target="_blank" className="font-medium text-foreground underline-offset-4 hover:underline">
                        {link.ref}
                      </a>
                    ) : (
                      <span key={link.ref} className="font-medium text-foreground">{link.ref}</span>
                    ),
                  )}
                </span>
              )}
              {repoLabel && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2 className="size-3.5 shrink-0" />
                  <span className="truncate font-mono" title={p.repos.map((r) => r.path).join("\n")}>{repoLabel}</span>
                </span>
              )}
              <span className="whitespace-nowrap">· updated {timeAgo(p.updatedAt)}</span>
            </div>
            {p.status === "waiting_for_user" && p.waitingFor && (
              <p className={cn("text-sm font-medium", statusConfig(p.status).text)}>{p.waitingFor}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {p.session?.t3Thread && <T3ThreadButton thread={p.session.t3Thread} />}
            <AgentLogo p={p} />
            {p.status === "ready" ? (
              p.preview && <ActionButton id={p.id} action="stopServer" />
            ) : p.status === "running" || p.status === "waiting_for_user" || (p.status === "failed" && p.preview) ? (
              <ActionButton id={p.id} action="stopPipeline" hasServers={!!p.preview} />
            ) : null}
            {!merging && done && <ActionButton id={p.id} action="delete" />}
          </div>
        </div>

        <Steps steps={displaySteps(p)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 px-6 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">Pull request stack</h3>
            {multi && p.merge?.status === "running" && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Merging {repoName(p.merge.repo)}…
              </span>
            )}
          </div>
          {stack}
        </div>

        <Tabs value={tab} onValueChange={setTab} className="py-5">
          <TabsList className="mx-6">
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
          <TabsContent value="test" className="flex flex-col gap-4 px-6">
            {p.preview && <PreviewPanel preview={p.preview} />}
            {p.testGuide && <TestGuide guide={p.testGuide} />}
            {!p.preview && !p.testGuide && <p className="text-sm text-muted-foreground">No test environment yet</p>}
          </TabsContent>
          {/* The code tab pads its own rows. */}
          <TabsContent value="code">
            <CodeTab p={p} target={target} onTarget={setTarget} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
