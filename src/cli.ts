#!/usr/bin/env bun
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { archivePipeline, deletePipeline, findRecipe, isAlive, killGroup, loadRecipe, previewLines, startPreview, stopPipeline, unarchivePipeline } from "./preview.ts";
import { openPrs } from "./pr.ts";
import { repoName } from "./repos.ts";
import { branchExists, repoInfo, type RepoInfo } from "./repo-info.ts";
import { detectSession, findT3Thread } from "./session.ts";
import { DEFAULT_PORT, isDashboardUp, requestDashboardUpdate, readDashboardPid, serve, spawnDashboard } from "./server.ts";
import { getUpdateInfo, updateInPlace } from "./update.ts";
import {
  STEPS, addRepo, createPipeline, home, listStates, lookupRepo, pipelineDir, readState, refreshSessionId, setBase, setMode, setStep, updateState, upsertChunk,
  waitForUser,
  type ChunkInput, type Mode, type StepName, type StepStatus,
} from "./state.ts";

const USAGE = `pipeship — state, test environments and dashboard for the /pipeship:run skill

  new [--repo <path>]... --title <text> [--source <name>] [--ref <id> [--url <url>]]... [--name <words>] [--mode full|quick] [--skip a,b]
                               records the calling agent session (harness, id, cwd) when one is found, and each repo with its base branch
                               repeat --repo for each repo the ticket touches; none is fine: add them later with "repo"
                               repeat --ref/--url for each ticket; the nth --url belongs to the nth --ref
                               --name: a 2 or 3 word id for a plain-text ticket or a work request; refs win
  get <id>                     print the state (JSON)
  list                         list pipelines
  step <id> <step> <status>    steps: ${STEPS.join(", ")}; status: pending, running, done, skipped, failed
  mode <id> quick|full         switch the mode; quick also skips the pending steps quick skips
  wait <id> <step> [--reason <text>]   pause for the user on this step: the step runs, the pipeline waits;
                               --reason is the question, shown on the dashboard card
  repo <id> <path>             add a repo and record its base (its current branch); does nothing if it is already there
  chunk <id> <name> [--repo r] [--worktree p] [--branch b] [--status s] [--pr url]
                               --repo (name or path) is required for a new chunk when the pipeline has several repos
  pr <id> [--title <text>] [--body-file <file>]   per repo: push the top chunk branch (--force-with-lease) and open its PR
                               on the repo base, recorded on the top chunk; an open PR is only pushed; a repo with no remote is skipped;
                               the body gets a "Chunks" list, and a "Related PRs" list with several repos; prints the PR URLs
  recipe <repo>...             print the recipe used to start the app for these repos, or "none"
  preview <id> [<worktree>] [--recipe file]   start the preview: each service runs from the top worktree of its repo;
                               <worktree> overrides it for a one-repo pipeline; a --recipe that works is saved for the pipeline's repos
  stop <id>                    stop the pipeline and its preview
  archive <id>                 archive a done, failed or stopped pipeline (its preview stops)
  unarchive <id>               unarchive an archived pipeline; its preview stays stopped
  delete <id> [--force]        delete its worktrees and files (local branches of merged PRs go; other branches and PRs stay); --force drops uncommitted changes
  update [--check] [--port n]  update the plugin in every harness (Claude Code, Codex) that installed it;
                               a running dashboard does it and restarts; --check only prints the versions
  dashboard [start|stop] [--port n]   start the dashboard in the background (default) or stop it
  serve [--port n]             run the dashboard in the foreground`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string", multiple: true }, title: { type: "string" }, name: { type: "string" }, source: { type: "string" },
    ref: { type: "string", multiple: true }, url: { type: "string", multiple: true }, mode: { type: "string" }, skip: { type: "string" },
    "body-file": { type: "string" }, worktree: { type: "string" }, branch: { type: "string" }, status: { type: "string" }, pr: { type: "string" },
    port: { type: "string" }, recipe: { type: "string" }, reason: { type: "string" }, force: { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
const port = values.port ? Number(values.port) : DEFAULT_PORT;
const print = (data: unknown) => console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}\n\n${USAGE}`);
  return value;
}

const repoReport = (info: RepoInfo, storedBase?: string) => ({
  path: info.path,
  name: repoName(info.path),
  base: storedBase ?? info.base ?? null,
  baseFrom: storedBase ? "state" : info.baseFrom ?? null,
  worktree: info.worktree ?? null,
  branch: info.branch ?? null,
  dirty: info.dirty,
});

async function startDashboard(): Promise<string> {
  const url = `http://localhost:${port}`;
  if (await isDashboardUp(port)) return url;
  spawnDashboard(process.execPath, [import.meta.path, "serve", "--port", String(port)]);
  for (let i = 0; i < 100; i++) {
    if (await isDashboardUp(port)) return url;
    await Bun.sleep(100);
  }
  throw new Error(`dashboard did not start, see ${join(home(), "dashboard.log")}`);
}

async function stopDashboard(): Promise<string> {
  const recorded = readDashboardPid();
  if (!recorded) return "dashboard not running";
  const { pid, startedAt } = recorded;
  if (isAlive(pid, startedAt)) await killGroup(pid, startedAt);
  rmSync(join(home(), "dashboard.pid"));
  return `dashboard stopped (pid ${pid})`;
}

async function main() {
  switch (command) {
    case "new": {
      const all = (values.repo ?? []).map((p) => repoInfo(resolve(p)));
      const infos = all.filter((r, i) => all.findIndex((o) => o.path === r.path) === i);
      const state = createPipeline({
        repos: infos.map((r) => ({ path: r.path, ...(r.base && { base: r.base }) })),
        title: need(values.title, "--title"),
        name: values.name,
        source: values.source,
        links: (values.ref ?? []).map((ref, i) => (values.url?.[i] ? { ref, url: values.url[i] } : { ref })),
        mode: (values.mode as Mode) ?? "full",
        skip: values.skip?.split(",").map((s) => s.trim()) as StepName[] | undefined,
        session: detectSession(),
      });
      const repos = infos.map((r) => repoReport(r));
      return print({ id: state.id, dir: pipelineDir(state.id), steps: state.steps.map((s) => `${s.name}:${s.status}`), session: state.session ?? null, repos });
    }
    case "repo": {
      const info = repoInfo(resolve(need(args[1], "<path>")));
      const { state, added } = addRepo(need(args[0], "<id>"), { path: info.path, ...(info.base && { base: info.base }) });
      const stored = state.repos.find((r) => r.path === info.path)!;
      return print({ ...repoReport(info, added ? undefined : stored.base), added });
    }
    case "base": {
      const id = need(args[0], "<id>");
      const repo = lookupRepo(readState(id), need(args[1], "<repo>"));
      const branch = need(args[2], "<branch>").replace(/^origin\//, "");
      const name = repoName(repo.path);
      if (!branchExists(repo.path, branch)) throw new Error(`unknown branch ${branch} in ${name}: no local branch and no origin/${branch}`);
      const { previous } = setBase(id, repo.path, branch);
      return print({ path: repo.path, name, base: branch, previous: previous ?? null });
    }
    case "get":
      return print(readState(need(args[0], "<id>")));
    case "list":
      return print(listStates().map((s) => `${s.id}\t${s.status}\t${s.step}\t${s.ticket.title}`).join("\n") || "no pipelines");
    case "step": {
      setStep(need(args[0], "<id>"), need(args[1], "<step>") as StepName, need(args[2], "<status>") as StepStatus);
      const session = refreshSessionId(args[0], detectSession());
      // T3 Code may record the session after `pipeship new`: look again at each step until found.
      const t3Thread = session && !session.t3Thread && findT3Thread(session);
      if (t3Thread) updateState(args[0], (s) => void (s.session!.t3Thread = t3Thread));
      return print("ok");
    }
    case "mode":
      setMode(need(args[0], "<id>"), need(args[1], "<mode>") as Mode);
      return print("ok");
    case "wait":
      waitForUser(need(args[0], "<id>"), need(args[1], "<step>") as StepName, values.reason);
      return print("ok");
    case "chunk": {
      if ((values.repo?.length ?? 0) > 1) throw new Error("chunk takes one --repo");
      const chunk: ChunkInput = { name: need(args[1], "<name>") };
      if (values.repo) chunk.repo = values.repo[0];
      if (values.worktree) chunk.worktree = resolve(values.worktree);
      if (values.branch) chunk.branch = values.branch;
      if (values.status) chunk.status = values.status;
      if (values.pr) chunk.pr = values.pr;
      upsertChunk(need(args[0], "<id>"), chunk);
      return print("ok");
    }
    case "pr": {
      const body = values["body-file"] ? readFileSync(resolve(values["body-file"]), "utf8") : undefined;
      return print((await openPrs(need(args[0], "<id>"), { title: values.title, body })).join("\n"));
    }
    case "recipe": {
      need(args[0], "<repo>");
      const repos = args.map((p) => resolve(p));
      const path = findRecipe(repos);
      return print(path ? { path, recipe: loadRecipe(path) } : "none");
    }
    case "preview": {
      const draft = values.recipe ? resolve(values.recipe) : undefined;
      const state = await startPreview(need(args[0], "<id>"), args[1] ? resolve(args[1]) : undefined, draft);
      return print(previewLines(state.preview!).join("\n"));
    }
    case "stop":
      await stopPipeline(need(args[0], "<id>"));
      return print("stopped");
    case "archive":
      await archivePipeline(need(args[0], "<id>"));
      return print("archived");
    case "unarchive":
      await unarchivePipeline(need(args[0], "<id>"));
      return print("unarchived");
    case "delete":
      await deletePipeline(need(args[0], "<id>"), { force: values.force });
      return print("deleted");
    case "update":
      if (values.check) return print(await getUpdateInfo());
      return print((await isDashboardUp(port)) ? await requestDashboardUpdate(port) : await updateInPlace());
    case "dashboard":
      return print(args[0] === "stop" ? await stopDashboard() : await startDashboard());
    case "serve":
      await serve(port, { prSync: true, retryMs: 8000 });
      return console.log(`pipeship dashboard on http://localhost:${port}`);
    default:
      print(USAGE);
      if (command && !values.help) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
