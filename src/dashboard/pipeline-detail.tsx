import { ArrowLeft, FolderGit2, GitMerge, Zap } from "lucide-react";
import { useState } from "react";
import { mergeRunning, repoChunks } from "../repos.ts";
import type { DashboardState } from "../state.ts";
import { PipelineActions, StartPreviewButton } from "./action-button";
import { CodeTab, type DiffTarget } from "./code-tab";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { MergeButton } from "./merge-button";
import { allMerged, displaySteps, finished, timeAgo } from "./pipeline-info";
import { NoPreviewPanel, PreviewPanel } from "./preview-panel";
import { AgentLogo, T3ThreadButton } from "./session";
import { ChunkList } from "./chunk-list";
import { StatusBadge } from "./status";
import { Steps } from "./steps";
import { TestGuide } from "./test-guide";
import { TicketIcon } from "./ticket-icon";
import { shortRepo } from "./utils";

export function PipelineDetail({ p, onBack }: { p: DashboardState; onBack: () => void }) {
  const [target, setTarget] = useState<DiffTarget>({});
  const [tab, setTab] = useState("test");
  const repos = repoChunks(p);
  const multi = p.repos.length > 1;
  const merging = mergeRunning(p);
  const done = finished(p);
  // The server knows a dashboard start is in flight; a CLI start only shows as services still without a pid.
  const starting = p.previewStarting || (p.preview?.services?.some((s) => s.pid === undefined) ?? false);
  const repoLabel =
    p.repos.length === 0 ? "" : multi ? repos.map((r) => r.name).join(" + ") : shortRepo(p.repos[0]!.path);
  const showTicket = p.ticket.links.length > 0 || (p.ticket.source && p.ticket.source !== "text");
  const select = (t: DiffTarget) => {
    setTarget(t);
    setTab("code");
  };
  const noBranch = <p className="text-xs text-muted-foreground">No branch yet</p>;
  // Same layout for one repo or several: the repo row carries its merge button.
  const prs =
    repos.length === 0
      ? noBranch
      : repos.map((r) => (
          <div key={r.repo.path} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium" title={r.name}>{r.name}</span>
              {/* The path shrinks first, so the repo name stays readable. */}
              <span className="min-w-0 shrink-[3] truncate font-mono text-xs text-muted-foreground" title={r.repo.path}>
                {shortRepo(r.repo.path)}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <MergeButton id={p.id} repo={r.repo.path} chunks={r.chunks} base={r.repo.base} merge={r.merge} finished={done} />
              </div>
            </div>
            {r.chunks.length > 0 ? (
              <ChunkList repo={r.repo} chunks={r.chunks} merge={r.merge} selected={target.chunk} onSelect={(chunk) => select({ chunk })} onSelectBase={() => select({})} />
            ) : (
              noBranch
            )}
          </div>
        ));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No status tint here: the list already carries the colour, the detail stays calm. */}
      <div className="flex flex-col gap-4 border-b bg-background px-6 py-5">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 hidden w-fit max-[899px]:inline-flex">
          <ArrowLeft /> Pipelines
        </Button>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4 max-[599px]:flex-col max-[599px]:items-start">
            {/* A long title is cut so the badges stay on its line. */}
            <div className="flex min-w-0 max-w-full items-center gap-3">
              <h2 className="min-w-0 truncate text-lg font-semibold leading-tight" title={p.ticket.title}>{p.ticket.title}</h2>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={p.status} />
                {p.mode === "quick" && (
                  <Badge variant="secondary" className="bg-pink-500/15 text-pink-700 dark:text-pink-400">
                    <Zap /> Quick
                  </Badge>
                )}
                {allMerged(p) && !merging && (
                  <Badge variant="secondary" className="bg-violet-500/15 text-violet-700 dark:text-violet-400">
                    <GitMerge /> Merged
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {(p.status === "done" || p.status === "ready") && (!p.preview || starting) && <StartPreviewButton id={p.id} starting={starting} />}
              <PipelineActions p={p} merging={merging} starting={starting} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 max-[599px]:flex-col max-[599px]:items-start">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {p.session?.t3Thread && <T3ThreadButton thread={p.session.t3Thread} />}
              <AgentLogo p={p} />
            </div>
          </div>
        </div>

        <Steps steps={displaySteps(p)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 px-6 pt-5">
          <h3 className="text-sm font-semibold">Pull requests</h3>
          {prs}
        </div>

        <Tabs value={tab} onValueChange={setTab} className="py-5">
          <TabsList className="mx-6">
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
          <TabsContent value="test" className="flex flex-col gap-4 px-6">
            {p.previewError && !p.preview && (
              <p className="text-sm text-destructive" title={p.previewError}>
                Preview failed: <span className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs">{p.previewError}</span>
              </p>
            )}
            {p.preview && !starting ? <PreviewPanel preview={p.preview} /> : !p.previewError && <NoPreviewPanel />}
            {p.testGuide && <TestGuide guide={p.testGuide} />}
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
