import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRepo, markRepoMerged, createPipeline, listStates, pipelineDir, pipelineStatus, readState, refreshSessionId, setMode, setStep, updateState, upsertChunk, waitForUser, type State,
} from "../src/state.ts";
import { chunksOf, diffRange, holdingPr, openPrChunks, repoName, repoChunks, sharesRepo, stackRefusal, topChunk } from "../src/repos.ts";
import {
  archiveIfAllMerged, archivePipeline, DASHBOARD_PORT, deletePipeline, findRecipe, isAlive, killGroup, mainService, normalizeRecipe, pickPorts, previewLines, processStart, resolveEnv,
  requestPreviewStart, savedRecipePath, startOrder, startPreview, stopPipeline, stopPreview, stopPreviewAndSettle, type Service, unarchivePipeline, waitReady,
} from "../src/preview.ts";
import { diffTotals, parseDiff } from "../src/diff.ts";
import { baseRef, DiffError, gitDiff, headRef, pipelineDiff, resetFetchCache } from "../src/diff-git.ts";
import { DEFAULT_PORT, readDashboardPid, requestDashboardUpdate, serve, spawnDashboard } from "../src/server.ts";
import {
  classifyPr, defaultRunner, DEFAULT_LIMITS, failStaleMerges, forceMerge, isMergeRunning, mergeRepo, MergeError, resolveMergeRepo, startMerge, type MergeDeps, type PrView, type Runner, type RunResult,
} from "../src/merge.ts";
import { startPrSync, syncPrStatuses } from "../src/pr-sync.ts";
import { openPrs } from "../src/pr.ts";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { detectSession, findT3Thread, type ReadProc } from "../src/session.ts";
import { groupByStatus } from "../src/dashboard/groups.ts";
import { t3ThreadLink } from "../src/dashboard/session.tsx";
import { buildSearch, parseUrl } from "../src/dashboard/url.ts";
import { allMerged, displaySteps, finished, formatElapsed, timeAgo, timeAgoShort } from "../src/dashboard/pipeline-info.ts";
import { isTestFile } from "../src/dashboard/test-files.ts";
import { diffRequests, diffUrl } from "../src/dashboard/diff-requests.ts";
import { buildFileTree, type TreeNode } from "../src/dashboard/file-tree.ts";
import { highlightLines, languageOf } from "../src/dashboard/highlight.tsx";
import { chunkActivity } from "../src/dashboard/status.tsx";
import { compareVersions, currentVersion, getUpdateInfo, detectHarness, installUpdate, readCodexInstalled, resetUpdateCache, UpdateError, updateInPlace } from "../src/update.ts";
import type { Chunk, Harness, MergeRun } from "../src/state.ts";
import { shouldReload } from "../src/dashboard/update-info.ts";

const root = mkdtempSync(join(tmpdir(), "pipeship-test-"));
process.env.PIPESHIP_HOME = join(root, "home");
process.env.T3CODE_HOME = join(root, "t3"); // never read the real T3 Code database
afterAll(() => rmSync(root, { recursive: true, force: true }));

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(root, "repo-"));
});


// The status is derived: tests set the facts it comes from.
const ALL_STEPS = ["explore", "questions", "plan", "implement", "review", "preview"] as const;
const finishBeforePreview = (id: string) => ALL_STEPS.slice(0, -1).forEach((name) => setStep(id, name, "done"));
const doneBefore = (id: string, step: (typeof ALL_STEPS)[number]) => ALL_STEPS.slice(0, ALL_STEPS.indexOf(step)).forEach((name) => setStep(id, name, "done"));
const finishSteps = (id: string) => ALL_STEPS.forEach((name) => setStep(id, name, "done"));
const requestStop = (id: string) => updateState(id, (s) => void (s.stopRequested = true));
const archiveNow = (id: string) => updateState(id, (s) => void (s.archivedAt = new Date().toISOString()));
const previewFact = () => ({ url: "http://localhost:1", port: 1, pid: 1, log: "x", repo, worktree: repo }) as never;

test("quick mode and --skip mark steps as skipped", () => {
  const quick = createPipeline({ repos: [{ path: repo }], title: "Add date filter", source: "text", mode: "quick" });
  expect(quick.steps.find((s) => s.name === "plan")!.status).toBe("skipped");

  const custom = createPipeline({ repos: [{ path: repo }], title: "x", source: "linear", links: [{ ref: "ABC-1" }], skip: ["questions", "review"] });
  expect(custom.steps.filter((s) => s.status === "skipped").map((s) => s.name)).toEqual(["questions", "review"]);
});

test("--skip refuses a name that is not a step, and names the valid ones", () => {
  const before = listStates().length;
  expect(() => createPipeline({ repos: [{ path: repo }], title: "x", skip: ["questions", "stack" as never] })).toThrow(
    "unknown step in --skip: stack (expected explore, questions, plan, implement, review, preview)",
  );
  expect(listStates()).toHaveLength(before);
});

test("ids are unique for the same ticket", () => {
  const a = createPipeline({ repos: [{ path: repo }], title: "t", source: "linear", links: [{ ref: "ABC-2" }] });
  const b = createPipeline({ repos: [{ path: repo }], title: "t", source: "linear", links: [{ ref: "ABC-2" }] });
  expect(a.id).not.toBe(b.id);
  expect(listStates().map((s) => s.id)).toContain(b.id);
});

test("steps and chunks update the state", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  setStep(id, "explore", "done");
  setStep(id, "questions", "running");
  upsertChunk(id, { name: "api", branch: "feat/api" });
  upsertChunk(id, { name: "api", pr: "https://example.com/pr/1" });
  const state = readState(id);
  expect(state.step).toBe("questions");
  expect(state.chunks).toEqual([{ name: "api", repo, branch: "feat/api", pr: "https://example.com/pr/1" }]);
  expect(() => setStep(id, "nope" as never, "done")).toThrow("unknown step");
});

test("the pipeline is done once every step is done or skipped, and ready when a preview runs", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text", skip: ["preview"] });
  doneBefore(id, "review");
  expect(readState(id).status).toBe("running");
  setStep(id, "review", "done");
  expect(readState(id).status).toBe("done");

  const withPreview = createPipeline({ repos: [{ path: repo }], title: "p", source: "text", skip: ["preview"] }).id;
  updateState(withPreview, (s) => {
    s.preview = { url: "http://localhost:1", port: 1, pid: 1, log: "x", repo, worktree: repo } as never;
  });
  for (const name of ["explore", "questions", "plan", "implement", "review"] as const) setStep(withPreview, name, "done");
  expect(readState(withPreview).status).toBe("ready");
});

test("a step reopened on a ready or done pipeline sets it back to running", () => {
  const all = ["explore", "questions", "plan", "implement", "review", "preview"] as const;
  const id = createPipeline({ repos: [{ path: repo }], title: "r", source: "text" }).id;
  updateState(id, (s) => {
    s.preview = { url: "http://localhost:1", port: 1, pid: 1, log: "x", repo, worktree: repo } as never;
  });
  for (const name of all) setStep(id, name, "done");
  expect(readState(id).status).toBe("ready");
  expect(setStep(id, "implement", "running").status).toBe("running");
  expect(setStep(id, "implement", "done").status).toBe("ready");

  const done = createPipeline({ repos: [{ path: repo }], title: "d", source: "text" }).id;
  for (const name of all) setStep(done, name, "done");
  expect(readState(done).status).toBe("done");
  expect(setStep(done, "review", "pending").status).toBe("running");
  expect(setStep(done, "review", "done").status).toBe("done");

  const archived = createPipeline({ repos: [{ path: repo }], title: "a", source: "text" }).id;
  for (const name of all) setStep(archived, name, "done");
  archiveNow(archived);
  expect(setStep(archived, "review", "running").status).toBe("running");
});

test("a step run again loses the end of its previous run", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  expect(setStep(id, "explore", "done").steps[0]!.endedAt).toBeDefined();
  expect(setStep(id, "explore", "running").steps[0]!.endedAt).toBeUndefined();
  setStep(id, "explore", "done");
  setStep(id, "questions", "failed");
  expect(waitForUser(id, "questions").steps[1]!.endedAt).toBeUndefined();
});

test("a failed step run again and done lets the pipeline go back to running, then done", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text", mode: "quick" });
  doneBefore(id, "review");
  setStep(id, "review", "failed");
  expect(readState(id).status).toBe("failed");
  expect(setStep(id, "review", "running").status).toBe("running");
  for (const name of ["explore", "questions", "implement", "review", "preview"] as const) setStep(id, name, "done");
  expect(readState(id).status).toBe("done");
});

const rules = () => createPipeline({ repos: [{ path: repo }], title: "rules", source: "text" }).id;

test("pipelineStatus: archivedAt wins over every other fact", () => {
  const id = rules();
  setStep(id, "explore", "done");
  waitForUser(id, "questions");
  setStep(id, "explore", "failed");
  requestStop(id);
  archiveNow(id);
  expect(readState(id).status).toBe("archived");
  expect(pipelineStatus({ archivedAt: "x", steps: [], stopRequested: true, waiting: { step: "plan" } })).toBe("archived");
});

test("pipelineStatus: a failed step makes the pipeline failed, even when stopped or waiting", () => {
  const id = rules();
  setStep(id, "explore", "done");
  waitForUser(id, "questions");
  setStep(id, "explore", "failed");
  requestStop(id);
  expect(readState(id).status).toBe("failed");
});

test("pipelineStatus: stopRequested makes the pipeline stopped, even when waiting", () => {
  const id = rules();
  setStep(id, "explore", "done");
  waitForUser(id, "questions");
  requestStop(id);
  expect(readState(id).status).toBe("stopped");
});

test("pipelineStatus: a waiting step makes the pipeline waiting_for_user", () => {
  const id = rules();
  setStep(id, "explore", "done");
  expect(waitForUser(id, "questions", "Which one?").status).toBe("waiting_for_user");
  expect(readState(id).waiting).toEqual({ step: "questions", reason: "Which one?" });
});

test("pipelineStatus: finished steps give done, or ready with a preview", () => {
  const id = rules();
  finishSteps(id);
  expect(readState(id).status).toBe("done");
  updateState(id, (s) => void (s.preview = previewFact()));
  expect(readState(id).status).toBe("ready");
});

test("pipelineStatus: unfinished steps give running", () => {
  const id = rules();
  expect(readState(id).status).toBe("running");
  setStep(id, "explore", "done");
  expect(readState(id).status).toBe("running");
});

test("resume after a stop: a step that starts clears stopRequested", async () => {
  const id = rules();
  setStep(id, "explore", "running");
  await stopPipeline(id);
  expect(readState(id).status).toBe("stopped");
  const resumed = setStep(id, "explore", "running");
  expect(resumed.stopRequested).toBe(false);
  expect(resumed.status).toBe("running");
});

test("an archived pipeline stays archived unless a step starts", () => {
  const id = rules();
  finishSteps(id);
  archiveNow(id);
  for (const status of ["failed", "skipped", "pending", "done"] as const) {
    expect(setStep(id, "review", status).status).toBe("archived");
  }
  const resumed = setStep(id, "review", "running");
  expect(resumed.status).toBe("running");
  expect(resumed.archivedAt).toBeUndefined();
  expect(setStep(id, "review", "done").status).toBe("done");
});

test("unarchivePipeline derives done or failed from the steps and refuses a pipeline that is not archived", async () => {
  const id = rules();
  finishSteps(id);
  await expect(unarchivePipeline(id)).rejects.toThrow("only an archived pipeline");
  archiveNow(id);
  const state = await unarchivePipeline(id);
  expect(state.archivedAt).toBeUndefined();
  expect(state.status).toBe("done");

  const failed = rules();
  finishSteps(failed);
  setStep(failed, "review", "failed");
  archiveNow(failed);
  expect((await unarchivePipeline(failed)).status).toBe("failed");
  await expect(unarchivePipeline("nope")).rejects.toThrow();
});

test("a wait ends when another step starts", () => {
  const id = rules();
  setStep(id, "explore", "done");
  waitForUser(id, "questions", "Which one?");
  const state = setStep(id, "explore", "running");
  expect(state.waiting).toBeUndefined();
  expect(state.status).toBe("running");
  expect(state.step).toBe("explore");
});

const stepStatuses = (id: string) => readState(id).steps.map((x) => x.status);

test("a step is refused while an earlier step is not done or skipped, and nothing changes", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  const before = readState(id);
  for (const status of ["running", "done", "failed"] as const) {
    expect(() => setStep(id, "plan", status)).toThrow(`cannot mark plan ${status}: explore is pending (earlier steps must be done or skipped)`);
  }
  expect(readState(id)).toEqual(before);
  setStep(id, "explore", "done");
  expect(() => setStep(id, "implement", "running")).toThrow("cannot mark implement running: questions is pending");
});

test("a failed or running earlier step blocks the next ones", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  setStep(id, "explore", "failed");
  expect(() => setStep(id, "questions", "running")).toThrow("explore is failed");
  setStep(id, "explore", "running");
  expect(() => setStep(id, "questions", "done")).toThrow("explore is running");
});

test("skipped satisfies the gate, also in quick mode", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text", mode: "quick" });
  setStep(id, "explore", "done");
  setStep(id, "questions", "done");
  expect(setStep(id, "implement", "running").step).toBe("implement");
  const custom = createPipeline({ repos: [{ path: repo }], title: "g", source: "text", skip: ["explore", "questions"] });
  expect(setStep(custom.id, "plan", "running").step).toBe("plan");
});

test("pending and skipped are allowed out of order", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  setStep(id, "review", "skipped");
  setStep(id, "preview", "pending");
  expect(stepStatuses(id)[4]).toBe("skipped");
  expect(() => setStep(id, "preview", "running")).toThrow("explore is pending");
});

test("reopening an earlier step is allowed, then later steps wait until it is done", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  finishSteps(id);
  expect(setStep(id, "explore", "running").status).toBe("running");
  expect(() => setStep(id, "implement", "running")).toThrow("cannot mark implement running: explore is running");
  setStep(id, "explore", "done");
  expect(setStep(id, "implement", "running").step).toBe("implement");
});

test("a feedback step on a done pipeline unarchives it and clears stopRequested", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  finishSteps(id);
  archiveNow(id);
  requestStop(id);
  const state = setStep(id, "implement", "running");
  expect(state.archivedAt).toBeUndefined();
  expect(state.stopRequested).toBe(false);
  expect(state.status).toBe("running");
});

test("a stopped pipeline resumes when its running step starts again", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  setStep(id, "explore", "done");
  setStep(id, "questions", "running");
  requestStop(id);
  expect(setStep(id, "questions", "running").stopRequested).toBe(false);
});

test("waitForUser follows the same gate and works once the earlier steps are done", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "g", source: "text" });
  const before = readState(id);
  expect(() => waitForUser(id, "questions", "Which one?")).toThrow("cannot wait on questions: explore is pending (earlier steps must be done or skipped)");
  expect(readState(id)).toEqual(before);
  setStep(id, "explore", "done");
  expect(waitForUser(id, "questions", "Which one?").status).toBe("waiting_for_user");
  expect(() => waitForUser(id, "explore")).toThrow("nothing to wait on");
});

test("preview starts the app, copies local files, and stop kills it", async () => {
  writeFileSync(join(repo, ".env.local"), "SECRET=1");
  const worktree = mkdtempSync(join(root, "wt-"));
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      start: `bun -e "Bun.serve({ port: Number(process.env.APP_PORT), fetch: () => new Response('hello') })"`,
      portEnv: "APP_PORT",
      copyFiles: [".env.local"],
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "Preview test", source: "text", links: [{ ref: "DEMO-7" }] });

  finishBeforePreview(id);
  const state = await startPreview(id, worktree);
  expect(state.status).toBe("ready");
  const { port } = state.preview!;
  expect(state.preview!.url).toBe(`http://localhost:${port}`);
  expect(port).toBeGreaterThanOrEqual(3000);
  expect(port).toBeLessThan(4000);
  expect(state.preview!.services).toEqual([
    {
      name: "app", kind: "front", port, url: `http://localhost:${port}`, pid: state.preview!.pid, startedAt: expect.any(String),
      log: join(pipelineDir(id), "preview-app.log"), repo, worktree,
    },
  ]);
  expect(previewLines(state.preview!)).toEqual([`http://localhost:${port}`]);
  expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe("SECRET=1");
  expect(await (await fetch(`http://localhost:${state.preview!.port}`)).text()).toBe("hello");

  const pid = state.preview!.pid!;
  expect(isAlive(pid, state.preview!.services![0]!.startedAt)).toBe(true);
  const stopped = await stopPipeline(id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.stopRequested).toBe(true);
  expect(isAlive(pid)).toBe(false);

  // A done pipeline can start its test environment again.
  const again = await startPreview(id, worktree);
  expect(await (await fetch(again.preview!.url)).text()).toBe("hello");
  await stopPipeline(id);
  expect(isAlive(again.preview!.pid!)).toBe(false);
}, 30_000);

test("preview fails clearly when the server crashes", async () => {
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ start: "echo boom; exit 1" }));
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  await expect(startPreview(id, repo)).rejects.toThrow("boom");
  expect(readState(id).preview).toBeUndefined();
  expect(existsSync(join(pipelineDir(id), "preview-app.log"))).toBe(true);
}, 30_000);

test("a failing install rejects with its log and never starts the services", async () => {
  const marker = join(root, "started-marker");
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ install: "echo oops; exit 3", start: `touch ${marker}; sleep 60` }));
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const err = await startPreview(id, repo).then(() => undefined, (e: Error) => e);
  expect(err?.message).toContain("install failed (");
  expect(err?.message).toContain("oops");
  expect(readState(id).preview).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("the same install command runs once per worktree", async () => {
  const wt = mkdtempSync(join(root, "wt-"));
  const install = "echo x >> count";
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      install,
      services: [
        { name: "a", kind: "back", start: "exit 1", install },
        { name: "b", kind: "back", start: "exit 1", install },
      ],
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  await startPreview(id, wt).catch(() => undefined);
  expect(readFileSync(join(wt, "count"), "utf8").trim().split("\n")).toHaveLength(1);
}, 30_000);

test("a slow install does not block the event loop", async () => {
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      install: "sleep 1",
      start: `bun -e "Bun.serve({ port: Number(process.env.APP_PORT), fetch: () => new Response('ok') })"`,
      portEnv: "APP_PORT",
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  finishBeforePreview(id);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  try {
    await startPreview(id, repo);
    expect(ticks).toBeGreaterThanOrEqual(5);
  } finally {
    clearInterval(timer);
    await stopPipeline(id).catch(() => undefined);
  }
}, 30_000);

test("a draft recipe is saved for the repo only when the app starts", async () => {
  const draft = join(root, "draft.json");
  writeFileSync(draft, JSON.stringify({ start: "exit 1" }));
  const first = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  await expect(startPreview(first.id, repo, draft)).rejects.toThrow();
  expect(existsSync(savedRecipePath([repo]))).toBe(false);

  writeFileSync(draft, JSON.stringify({ start: `bun -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` }));
  await startPreview(first.id, repo, draft);
  await stopPipeline(first.id);
  expect(findRecipe([repo])).toBe(savedRecipePath([repo]));

  // The next pipeline in the same repo reuses the saved recipe without a draft.
  const second = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  finishBeforePreview(second.id);
  const state = await startPreview(second.id, repo);
  expect(state.status).toBe("ready");
  await stopPipeline(second.id);
}, 30_000);

test("a pipeline keeps one link per ticket, and old state files are upgraded", () => {
  const { id } = createPipeline({
    repos: [{ path: repo }], title: "t", source: "linear",
    links: [{ ref: "ABC-3", url: "https://example.com/ABC-3" }, { ref: "ABC-4", url: "https://example.com/ABC-4" }],
  });
  expect(id).toEndWith("abc-3-abc-4");
  expect(readState(id).ticket.links.map((l) => l.ref)).toEqual(["ABC-3", "ABC-4"]);

  const path = join(process.env.PIPESHIP_HOME!, "pipelines", id, "state.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  old.ticket = { source: "linear", title: "t", ref: "ABC-3,ABC-4", url: "https://example.com/ABC-3" };
  writeFileSync(path, JSON.stringify(old));
  expect(readState(id).ticket.links).toEqual([{ ref: "ABC-3", url: "https://example.com/ABC-3" }, { ref: "ABC-4" }]);
});

test("delete removes the worktrees and files, keeps the branch, and protects uncommitted work", async () => {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const wt = join(pipelineDir(id), "worktrees", "main");
  git(repo, "worktree", "add", "-q", "-b", "pipeship/test/main", wt);

  await expect(deletePipeline(id)).rejects.toThrow("stop the pipeline");
  finishSteps(id);
  writeFileSync(join(wt, "draft.ts"), "work in progress");
  await expect(deletePipeline(id)).rejects.toThrow("uncommitted changes");
  expect(existsSync(wt)).toBe(true);

  await deletePipeline(id, { force: true });
  expect(existsSync(pipelineDir(id))).toBe(false);
  expect(git(repo, "worktree", "list").stdout).not.toContain(wt);
  expect(git(repo, "branch", "--list", "pipeship/test/main").stdout).toContain("pipeship/test/main");
});

test("package.json and both plugin manifests declare the same version", () => {
  const version = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf8")).version;
  const expected = version("package.json");
  expect(version(".claude-plugin/plugin.json")).toBe(expected);
  expect(version(".codex-plugin/plugin.json")).toBe(expected);
});

test("ids have no date: refs, --name, then the first 3 words of the title", () => {
  const one = createPipeline({ repos: [{ path: repo }], title: "t", source: "linear", links: [{ ref: "IDA-1" }] });
  expect(one.id).toBe("ida-1");
  const two = createPipeline({ repos: [{ path: repo }], title: "t", source: "linear", links: [{ ref: "IDB-1" }, { ref: "IDB-2" }] });
  expect(two.id).toBe("idb-1-idb-2");
  expect(createPipeline({ repos: [{ path: repo }], title: "Link sessions", name: "session-link", source: "text" }).id).toBe("session-link");
  expect(createPipeline({ repos: [{ path: repo }], title: "t", name: "ignored-name", source: "linear", links: [{ ref: "IDC-1" }] }).id).toBe("idc-1");
  expect(createPipeline({ repos: [{ path: repo }], title: "Link each pipeline to its agent", source: "text" }).id).toBe("link-each-pipeline");
  expect(createPipeline({ repos: [{ path: repo }], title: "Créer un lien rapide", source: "text" }).id).toBe("creer-un-lien");
});

test("duplicate ids get -2 then -3", () => {
  const ids = [1, 2, 3].map(() => createPipeline({ repos: [{ path: repo }], title: "t", name: "dup-name", source: "text" }).id);
  expect(ids).toEqual(["dup-name", "dup-name-2", "dup-name-3"]);
});

const CLAUDE_ID = "cb41411e-2eaf-4c0e-b494-97ea2a18163f";
const CODEX_ID = "01a135f6-c8ab-7312-975b-351fdc9c7173";

function fakeHomes() {
  const dir = mkdtempSync(join(root, "homes-"));
  const homes = { claude: join(dir, "claude"), codex: join(dir, "codex"), t3: join(dir, "t3") };
  mkdirSync(join(homes.claude, "sessions"), { recursive: true });
  mkdirSync(homes.codex, { recursive: true });
  return homes;
}

function procs(chain: { argv0: string; comm?: string; exe?: string }[]): ReadProc {
  return (pid) => {
    const p = chain[pid - 100];
    return p && { ppid: pid + 1 === 100 + chain.length ? 1 : pid + 1, argv0: p.argv0, comm: p.comm ?? "x", exe: p.exe };
  };
}

test("detection finds the nearest claude ancestor", () => {
  const homes = fakeHomes();
  writeFileSync(join(homes.claude, "sessions", "1.json"), JSON.stringify({ pid: 1, sessionId: CLAUDE_ID, cwd: "/work/dir" }));
  const read = procs([{ argv0: "zsh" }, { argv0: "claude" }, { argv0: "t3" }]);
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID };
  expect(detectSession({ env, startPid: 100, readProc: read, homes, cwd: "/fallback" })).toEqual({ harness: "claude", id: CLAUDE_ID, cwd: "/work/dir" });
  expect(detectSession({ env, startPid: 100, readProc: read, homes: fakeHomes(), cwd: "/fallback" })?.cwd).toBe("/fallback");
});

test("a codex shell under a claude session counts as codex", () => {
  const homes = fakeHomes();
  const read = procs([{ argv0: "zsh" }, { argv0: "/x/bin/codex", comm: "codex" }, { argv0: "claude" }]);
  const both = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: CODEX_ID, CODEX_SESSION_ID: "01a135f8-b528-7c11-9204-49a8a1627a10" };
  expect(detectSession({ env: both, startPid: 100, readProc: read, homes, cwd: "/c" })).toEqual({ harness: "codex", id: CODEX_ID, cwd: "/c" });
  const only = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_SESSION_ID: "01a135f8-b528-7c11-9204-49a8a1627a10" };
  expect(detectSession({ env: only, startPid: 100, readProc: read, homes })?.id).toBe("01a135f8-b528-7c11-9204-49a8a1627a10");
});

test("env vars alone are not enough", () => {
  const homes = fakeHomes();
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID };
  const none = procs([{ argv0: "zsh" }, { argv0: "sshd" }]);
  expect(detectSession({ env, startPid: 100, readProc: none, homes })).toBeUndefined();
  const claude = procs([{ argv0: "zsh" }, { argv0: "claude" }]);
  expect(detectSession({ env: {}, startPid: 100, readProc: claude, homes })).toBeUndefined();
  expect(detectSession({ env: { CLAUDE_CODE_SESSION_ID: "../../etc" }, startPid: 100, readProc: claude, homes })).toBeUndefined();
});

test("claude is matched by CLAUDE_CODE_EXECPATH", () => {
  const homes = fakeHomes();
  const path = "/opt/x/2.1.296";
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CLAUDE_CODE_EXECPATH: path };
  const read = procs([{ argv0: "zsh" }, { argv0: path, comm: "2.1.296", exe: path }]);
  expect(detectSession({ env, startPid: 100, readProc: read, homes })?.harness).toBe("claude");
  expect(detectSession({ env: { ...env, CLAUDE_CODE_EXECPATH: "/usr/bin/node" }, startPid: 100, readProc: read, homes })).toBeUndefined();
});

test("pipelines record their session, and old state files without one still load", () => {
  const session = { harness: "codex" as const, id: CODEX_ID, cwd: "/w" };
  const withSession = createPipeline({ repos: [{ path: repo }], title: "t", source: "text", session });
  expect(readState(withSession.id).session).toEqual(session);

  const plain = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  expect("session" in readState(plain.id)).toBe(false);
  const path = join(pipelineDir(plain.id), "state.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  delete old.session;
  writeFileSync(path, JSON.stringify(old));
  expect(readState(plain.id).session).toBeUndefined();
});

const T3_ENV = "affd9b7d-69f6-438e-8932-c374ef17ed06";
const T3_THREAD = "2b0c8b67-4a50-43db-ad6a-1ee58fc13c67";

function fakeT3Home(rows: { thread: string; cursor: object; deleted?: boolean }[], dir = mkdtempSync(join(root, "t3-"))) {
  mkdirSync(join(dir, "userdata"), { recursive: true });
  writeFileSync(join(dir, "userdata", "environment-id"), `${T3_ENV}\n`);
  const db = new Database(join(dir, "userdata", "state.sqlite"));
  db.run("CREATE TABLE IF NOT EXISTS provider_session_runtime (thread_id TEXT, resume_cursor_json TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT, deleted_at TEXT)");
  for (const r of rows) {
    db.run("INSERT INTO provider_session_runtime VALUES (?, ?)", [r.thread, JSON.stringify(r.cursor)]);
    db.run("INSERT INTO projection_threads VALUES (?, ?)", [r.thread, r.deleted ? "2026-10-01" : null]);
  }
  db.close();
  return dir;
}

test("a session is matched to the T3 Code thread that runs it", () => {
  const t3 = fakeT3Home([
    { thread: T3_THREAD, cursor: { threadId: T3_THREAD, resume: CLAUDE_ID } },
    { thread: "11111111-2222-4333-8444-555555555555", cursor: { threadId: CODEX_ID } },
    { thread: "99999999-2222-4333-8444-555555555555", cursor: { resume: "dddddddd-2eaf-4c0e-b494-97ea2a18163f" }, deleted: true },
  ]);
  expect(findT3Thread({ harness: "claude", id: CLAUDE_ID, cwd: "/w" }, t3)).toEqual({ environmentId: T3_ENV, threadId: T3_THREAD });
  expect(findT3Thread({ harness: "codex", id: CODEX_ID, cwd: "/w" }, t3)).toEqual({ environmentId: T3_ENV, threadId: "11111111-2222-4333-8444-555555555555" });
  // The harness picks the cursor field: a claude id never matches a codex thread.
  expect(findT3Thread({ harness: "claude", id: CODEX_ID, cwd: "/w" }, t3)).toBeUndefined();
  expect(findT3Thread({ harness: "claude", id: "dddddddd-2eaf-4c0e-b494-97ea2a18163f", cwd: "/w" }, t3)).toBeUndefined();
  expect(findT3Thread({ harness: "claude", id: CLAUDE_ID, cwd: "/w" }, join(root, "no-t3"))).toBeUndefined();
  expect(t3ThreadLink({ environmentId: T3_ENV, threadId: T3_THREAD })).toBe(`t3code://threads/${T3_ENV}/${T3_THREAD}`);

  // detectSession records the thread with the session.
  const homes = { ...fakeHomes(), t3 };
  const read = procs([{ argv0: "zsh" }, { argv0: "claude" }]);
  expect(detectSession({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, startPid: 100, readProc: read, homes, cwd: "/c" })?.t3Thread).toEqual({ environmentId: T3_ENV, threadId: T3_THREAD });
});

test("a session is matched through the T3 Code 0.1.0 database", () => {
  const dir = mkdtempSync(join(root, "t3v2-"));
  mkdirSync(join(dir, "userdata"), { recursive: true });
  writeFileSync(join(dir, "userdata", "environment-id"), `${T3_ENV}\n`);
  const db = new Database(join(dir, "userdata", "statev2.sqlite"));
  db.run("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, updated_at TEXT, payload_json TEXT)");
  db.run("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT)");
  const add = (thread: string, native: string, deleted?: boolean) => {
    db.run("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)", [thread, "2026-10-19", JSON.stringify({ nativeThreadRef: { nativeId: native } })]);
    db.run("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)", [thread, deleted ? "2026-10-19" : null]);
  };
  add(T3_THREAD, CLAUDE_ID);
  add("99999999-2222-4333-8444-555555555555", CODEX_ID, true);
  db.close();
  expect(findT3Thread({ harness: "claude", id: CLAUDE_ID, cwd: "/w" }, dir)).toEqual({ environmentId: T3_ENV, threadId: T3_THREAD });
  expect(findT3Thread({ harness: "codex", id: CODEX_ID, cwd: "/w" }, dir)).toBeUndefined();
});

test("step records the T3 Code thread once T3 Code knows the session", () => {
  const state = createPipeline({ repos: [{ path: repo }], title: "t", source: "text", session: { harness: "claude", id: CLAUDE_ID, cwd: "/w" } });
  const step = (status: string) =>
    spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), "step", state.id, "explore", status], { encoding: "utf8", env: process.env });
  step("running");
  expect(readState(state.id).session?.t3Thread).toBeUndefined();
  fakeT3Home([{ thread: T3_THREAD, cursor: { resume: CLAUDE_ID } }], process.env.T3CODE_HOME);
  step("done");
  expect(readState(state.id).session?.t3Thread).toEqual({ environmentId: T3_ENV, threadId: T3_THREAD });
  rmSync(process.env.T3CODE_HOME!, { recursive: true, force: true });
});

test("the CLI refuses a gated step or wait with exit code 1 and the message on stderr", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const run = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), ...args], { encoding: "utf8", env: process.env });
  const step = run("step", id, "plan", "running");
  expect(step.status).toBe(1);
  expect(step.stderr).toContain("cannot mark plan running: explore is pending");
  const wait = run("wait", id, "questions");
  expect(wait.status).toBe(1);
  expect(wait.stderr).toContain("cannot wait on questions: explore is pending");
  expect(readState(id).steps.every((x) => x.status === "pending")).toBe(true);
});

test("refreshSessionId records the new id after /clear for the same harness and cwd only", () => {
  const NEW_ID = "cccccccc-2eaf-4c0e-b494-97ea2a18163f";
  const state = createPipeline({ repos: [{ path: repo }], title: "t", source: "text", session: { harness: "claude", id: CLAUDE_ID, cwd: "/w" } });
  refreshSessionId(state.id, { harness: "codex", id: NEW_ID, cwd: "/w" });
  refreshSessionId(state.id, { harness: "claude", id: NEW_ID, cwd: "/elsewhere" });
  refreshSessionId(state.id, undefined);
  expect(readState(state.id).session?.id).toBe(CLAUDE_ID);
  expect(refreshSessionId(state.id, { harness: "claude", id: NEW_ID, cwd: "/w" })?.id).toBe(NEW_ID);
  expect(readState(state.id).session).toEqual({ harness: "claude", id: NEW_ID, cwd: "/w" });
});

const svc = (name: string, kind: string, extra: Partial<Service> = {}): Service => ({
  name, kind, start: "true", portEnv: "PORT", readyPath: "/", ready: "http", env: {}, ...extra,
});

test("a dashboard port constant matches the server", () => {
  expect(DASHBOARD_PORT).toBe(DEFAULT_PORT);
});

test("fronts take ports from 3000, other kinds from 4000", async () => {
  const ports = await pickPorts([svc("web", "front"), svc("api", "back"), svc("worker", "job"), svc("admin", "front")], async () => true);
  expect(ports).toEqual({ web: 3000, api: 4000, worker: 4001, admin: 3001 });
});

test("port picking skips 4400 and ports in use", async () => {
  const back = await pickPorts([svc("api", "back")], async (p) => p >= 4400);
  expect(back).toEqual({ api: 4401 });
  const front = await pickPorts([svc("web", "front")], async (p) => p !== 3000);
  expect(front).toEqual({ web: 3001 });
});

test("fixed ports are reserved and must be free", async () => {
  const services = [svc("db", "infra", { fixedPort: 4000, portEnv: undefined }), svc("api", "back")];
  expect(await pickPorts(services, async () => true)).toEqual({ db: 4000, api: 4001 });
  await expect(pickPorts(services, async (p) => p !== 4000)).rejects.toThrow("fixed port 4000 is already in use");
});

test("env templates resolve ports and the pipeline id, and leave other placeholders", () => {
  const env = { A: "http://localhost:${api.port}", B: "${HOME}", C: "${api.portx}", D: "app_${pipeline.id}" };
  expect(resolveEnv(env, { api: 4000 }, "abc-1")).toEqual({ A: "http://localhost:4000", B: "${HOME}", C: "${api.portx}", D: "app_abc-1" });
});

test("waitReady keeps waiting on 5xx answers and reports the last status", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 503 }) });
  try {
    const app = { name: "app", ready: "http" as const, readyPath: "/" };
    await expect(waitReady(app, server.port!, process.pid, join(root, "none.log"), 2000)).rejects.toThrow(
      'service "app" not ready after 2s (last status 503)',
    );
  } finally {
    server.stop(true);
  }
}, 15_000);

test("waitReady accepts a 404 and a server that recovers from a 500", async () => {
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch: () => new Response("x", { status: ++hits <= 2 ? 500 : 404 }) });
  try {
    const app = { name: "app", ready: "http" as const, readyPath: "/" };
    await waitReady(app, server.port!, process.pid, join(root, "none.log"), 15_000);
    expect(hits).toBeGreaterThanOrEqual(3);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("start order is back and other kinds, then fronts; the main service is the first front", () => {
  const list = [svc("web", "front"), svc("api", "back"), svc("admin", "front"), svc("worker", "job")];
  expect(startOrder(list).map((s) => s.name)).toEqual(["api", "worker", "web", "admin"]);
  expect(mainService(list).name).toBe("web");
  expect(mainService([svc("api", "back"), svc("worker", "job")]).name).toBe("api");
});

test("recipe validation errors", () => {
  const bad = (recipe: object) => () => normalizeRecipe(recipe as never, "r.json");
  const ok = { name: "a", kind: "back", start: "x" };
  expect(bad({ start: "x", services: [ok] })).toThrow('r.json: use either "start" or "services", not both');
  expect(bad({})).toThrow('r.json: "start" or "services" is required');
  expect(bad({ services: [] })).toThrow('r.json: "services" must be a non-empty list');
  expect(bad({ services: [{ kind: "back", start: "x" }] })).toThrow('r.json: service #1 needs a "name"');
  expect(bad({ services: [{ ...ok, name: "a b" }] })).toThrow('service name "a b" may only use letters, digits, "-" and "_"');
  expect(bad({ services: [ok, ok] })).toThrow('duplicate service name "a"');
  expect(bad({ services: [{ name: "a", kind: "back" }] })).toThrow('service "a": "start" is required');
  expect(bad({ services: [{ name: "a", start: "x" }] })).toThrow('service "a": "kind" is required');
  expect(bad({ services: [{ ...ok, fixedPort: 70000 }] })).toThrow('service "a": "fixedPort" must be a port number');
  expect(bad({ services: [ok, { ...ok, name: "b", fixedPort: 5432 }, { ...ok, name: "c", fixedPort: 5432 }] })).toThrow(
    'service "c": fixed port 5432 is already used by "b"',
  );
  expect(bad({ services: [{ ...ok, env: [] }] })).toThrow('service "a": "env" must be an object');
  expect(bad({ services: [{ ...ok, env: "K=1" }] })).toThrow('service "a": "env" must be an object');
  expect(bad({ services: ["x"] })).toThrow("r.json: service #1 must be an object");
  expect(bad({ services: [{ ...ok, readyPath: "health" }] })).toThrow('service "a": "readyPath" must start with "/"');
  expect(bad({ start: "x", readyPath: "health" })).toThrow('r.json: "readyPath" must start with "/"');
  expect(bad({ services: [{ ...ok, ready: "udp" }] })).toThrow('service "a": "ready" must be "http" or "tcp"');
  expect(bad({ services: [{ ...ok, env: { K: 1 } }] })).toThrow('service "a": env "K" must be a string');
  expect(bad({ services: [{ ...ok, env: { K: "${nope.port}" } }] })).toThrow('env "K" refers to unknown service "nope"');
  expect(bad({ services: [{ ...ok, env: { K: "${a.port}" } }] })).toThrow('env "K" refers to its own port');

  expect(normalizeRecipe({ start: "bun dev" })).toEqual([
    { name: "app", kind: "front", start: "bun dev", portEnv: "PORT", readyPath: "/", ready: "http", env: {} },
  ]);
  expect(normalizeRecipe({ services: [{ ...ok, fixedPort: 5432 }] })[0]!.portEnv).toBeUndefined();
});

test("a multi-service recipe starts back ends first, wires ports, and stop kills every service", async () => {
  const api = `Bun.serve({ port: Number(process.env.API_PORT), fetch: () => new Response('api') })`;
  const web = `await fetch(process.env.API_URL); Bun.serve({ port: Number(process.env.WEB_PORT), fetch: () => new Response(process.env.API_URL) })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "web", kind: "front", start: `bun -e "${web}"`, portEnv: "WEB_PORT", env: { API_URL: "http://localhost:${api.port}" } },
        { name: "api", kind: "back", start: `bun -e "${api}"`, portEnv: "API_PORT" },
      ],
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const state = await startPreview(id, repo);
  const preview = state.preview!;
  const [first, second] = preview.services!;
  expect([first!.name, second!.name]).toEqual(["api", "web"]);
  expect(second!.port).toBeGreaterThanOrEqual(3000);
  expect(second!.port).toBeLessThan(4000);
  expect(first!.port).toBeGreaterThanOrEqual(4000);
  expect(first!.port).toBeLessThan(5000);
  expect(first!.port).not.toBe(4400);
  expect(preview.url).toBe(second!.url);
  expect(preview.pid).toBe(second!.pid);
  expect(await (await fetch(second!.url)).text()).toBe(first!.url);
  expect(existsSync(first!.log) && existsSync(second!.log)).toBe(true);
  expect(previewLines(preview)).toHaveLength(3);

  await stopPipeline(id);
  expect(isAlive(first!.pid!) || isAlive(second!.pid!)).toBe(false);
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

test("a failed service stops the services already started", async () => {
  const api = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('api') })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "api", kind: "back", start: `bun -e "${api}"` },
        { name: "web", kind: "front", start: "echo api=$API_URL db=$DB_NAME; exit 1", env: { API_URL: "http://localhost:${api.port}", DB_NAME: "app_${pipeline.id}" } },
      ],
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const error = await startPreview(id, repo).catch((e: Error) => e);
  expect((error as Error).message).toMatch(/service "web" exited.*api=http:\/\/localhost:\d+/s);
  expect((error as Error).message).toContain(`db=app_${id}`);
  const port = /api=http:\/\/localhost:(\d+)/.exec((error as Error).message)![1];
  await expect(fetch(`http://localhost:${port}`)).rejects.toThrow();
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

function fakePreview(id: string, pid: number | undefined, extra: object = {}) {
  updateState(id, (s) => {
    s.preview = { url: "http://localhost:3000", port: 3000, pid, log: "x", ...extra };
  });
}

test("isAlive and killGroup trust a pid only with its recorded start time", async () => {
  const mine = processStart(process.pid);
  expect(mine).toBeTruthy();
  expect(isAlive(process.pid, mine)).toBe(true);
  expect(isAlive(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  try {
    await killGroup(sleeper.pid, "Thu Jan  1 00:00:00 1970");
    expect(isAlive(sleeper.pid)).toBe(true);
  } finally {
    process.kill(sleeper.pid);
  }
}, 30_000);

test("stop leaves a recycled pid alone and clears the preview", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  fakePreview(id, sleeper.pid, {
    services: [{
      name: "app", kind: "front", port: 3000, url: "http://localhost:3000", pid: sleeper.pid, log: "x", repo, worktree: repo,
      startedAt: "Thu Jan  1 00:00:00 1970",
    }],
  });
  try {
    await stopPipeline(id);
    expect(isAlive(sleeper.pid)).toBe(true);
    expect(readState(id).preview).toBeUndefined();
  } finally {
    process.kill(sleeper.pid);
  }
}, 30_000);

test("the dashboard pid file keeps the start time and reads the old format", () => {
  const file = join(process.env.PIPESHIP_HOME!, "dashboard.pid");
  spawnDashboard("sleep", ["30"]);
  const recorded = readDashboardPid()!;
  try {
    expect(recorded).toEqual({ pid: recorded.pid, startedAt: processStart(recorded.pid) });
    expect(recorded.startedAt).toBeTruthy();
  } finally {
    process.kill(recorded.pid);
  }
  writeFileSync(file, "123");
  expect(readDashboardPid()).toEqual({ pid: 123 });
  rmSync(file);
});

test("stop handles an old state without services", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  fakePreview(id, sleeper.pid);
  try {
    await stopPipeline(id);
    expect(isAlive(sleeper.pid)).toBe(false);
    expect(readState(id).preview).toBeUndefined();
  } finally {
    if (isAlive(sleeper.pid)) process.kill(sleeper.pid);
  }
}, 30_000);

test("a fixed-port recipe refuses a second live pipeline of the same repo", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const a = createPipeline({ repos: [{ path: repo }], title: "a", name: "fixed-a", source: "text" });
  const b = createPipeline({ repos: [{ path: repo }], title: "b", name: "fixed-b", source: "text" });
  fakePreview(a.id, sleeper.pid);
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ services: [{ name: "db", kind: "infra", start: "sleep 60", fixedPort: 4999 }] }));
  try {
    await expect(startPreview(b.id, repo)).rejects.toThrow("live preview");
  } finally {
    await stopPipeline(a.id);
    await stopPipeline(b.id);
    if (isAlive(sleeper.pid)) process.kill(sleeper.pid);
  }
}, 30_000);

test("pickPorts skips reserved ports, fixed ones included", async () => {
  expect(await pickPorts([svc("web", "front"), svc("api", "back")], async () => true, new Set([3000, 4000, 4001]))).toEqual({ web: 3001, api: 4002 });
  const db = svc("db", "infra", { fixedPort: 5432, portEnv: undefined });
  await expect(pickPorts([db], async () => true, new Set([5432]))).rejects.toThrow("fixed port 5432 is already in use");
});

test("a pipeline still starting blocks a fixed-port recipe", async () => {
  const a = createPipeline({ repos: [{ path: repo }], title: "a", name: "starting-a", source: "text" });
  const b = createPipeline({ repos: [{ path: repo }], title: "b", name: "starting-b", source: "text" });
  fakePreview(a.id, undefined, { services: [{ name: "db", kind: "infra", port: 4999, url: "http://localhost:4999", log: "x" }] });
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ services: [{ name: "db", kind: "infra", start: "sleep 60", fixedPort: 4998 }] }));
  await expect(startPreview(b.id, repo)).rejects.toThrow("live preview");
});

test("a start avoids the ports another pipeline has planned", async () => {
  const a = createPipeline({ repos: [{ path: repo }], title: "a", name: "reserve-a", source: "text" });
  const b = createPipeline({ repos: [{ path: repo }], title: "b", name: "reserve-b", source: "text" });
  fakePreview(a.id, undefined, { port: 3000, services: [{ name: "app", kind: "front", port: 3000, url: "http://localhost:3000", log: "x" }] });
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({ start: `bun -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` }),
  );
  try {
    const state = await startPreview(b.id, repo);
    expect(state.preview!.port).toBe(3001);
  } finally {
    await stopPipeline(b.id);
  }
}, 30_000);

test("a tcp service is ready once its port accepts connections", async () => {
  const db = `Bun.listen({ hostname: 'localhost', port: Number(process.env.DB_PORT), socket: { data() {} } }); setInterval(() => {}, 1e6)`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({ services: [{ name: "db", kind: "infra", start: `bun -e "${db}"`, portEnv: "DB_PORT", ready: "tcp", readyPath: "/ignored" }] }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  finishBeforePreview(id);
  try {
    const state = await startPreview(id, repo);
    expect(state.status).toBe("ready");
    expect(state.preview!.services![0]!.pid).toBeDefined();
  } finally {
    await stopPipeline(id);
  }
}, 30_000);

test("stop during a slow start leaves no service running", async () => {
  const api = `await Bun.sleep(2000); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('api') })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "api", kind: "back", start: `bun -e "${api}"` },
        { name: "web", kind: "front", start: "sleep 60" },
      ],
    }),
  );
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  const pending = startPreview(id, repo).then(() => undefined, (e: Error) => e);
  await Bun.sleep(500);
  const during = readState(id).preview!.services!;
  await stopPipeline(id);
  expect(await pending).toBeInstanceOf(Error);
  const after = readState(id);
  expect(after.preview).toBeUndefined();
  expect(after.status).toBe("stopped");
  // The front service is never spawned, and the back one is dead.
  expect(during.find((x) => x.name === "web")!.pid).toBeUndefined();
  expect(isAlive(during.find((x) => x.name === "api")!.pid!)).toBe(false);
  await Bun.sleep(300);
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

test("a plain-text ticket has no source", () => {
  const plain = createPipeline({ repos: [{ path: repo }], title: "Fix the footer" });
  expect(readState(plain.id).ticket).toEqual({ title: "Fix the footer", links: [] });
  const linear = createPipeline({ repos: [{ path: repo }], title: "t", source: "linear", links: [{ ref: "ABC-9" }] });
  expect(readState(linear.id).ticket.source).toBe("linear");
});

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("new records the base branch, and leaves it unset on a detached HEAD", () => {
  const created = (name: string) => {
    const r = spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), "new", "--repo", repo, "--title", "t", "--name", name], {
      encoding: "utf8",
      env: process.env,
    });
    return readState(JSON.parse(r.stdout).id);
  };
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  expect(created("on-branch").repos).toEqual([{ path: repo, base: "main" }]);
  sh(repo, "checkout", "-q", "--detach");
  expect(created("detached").repos).toEqual([{ path: repo }]);
});

// Merge stack: real git (local bare remote, read through ls-remote) behind a fake gh. The flow merges through gh and never rebases or pushes.
const commitFile = (cwd: string, name: string, content: string, msg: string) => {
  writeFileSync(join(cwd, name), content);
  sh(cwd, "add", ".");
  sh(cwd, "commit", "-q", "-m", msg);
};

function makeStack(n: number, commits = 1, name = "repo") {
  const dir = mkdtempSync(join(root, "stack-"));
  const origin = join(dir, "origin.git");
  const clone = join(dir, name);
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, clone);
  commitFile(clone, "base.txt", "base\n", "initial");
  sh(clone, "push", "-q", "origin", "main");
  const worktrees: string[] = [];
  for (let i = 1; i <= n; i++) {
    sh(clone, "checkout", "-q", "-b", `c${i}`, i === 1 ? "main" : `c${i - 1}`);
    // Several commits per chunk edit the same line of the same file: replaying an old commit
    // on top of the squash is an add/add conflict, so a wrong old tip cannot go unnoticed.
    for (let k = 0; k < commits; k++) {
      commitFile(clone, `f${i}.txt`, `${"ab"[k] ?? "z"}${commits === 1 ? `f${i}` : ""}\n`, `f${i} step ${k}`);
    }
    sh(clone, "push", "-q", "origin", `c${i}`);
    worktrees.push(join(dir, `wt-${i}`));
  }
  sh(clone, "checkout", "-q", "main");
  worktrees.forEach((wt, i) => sh(clone, "worktree", "add", "-q", wt, `c${i + 1}`));
  const { id } = createPipeline({ repos: [{ path: clone, base: "main" }], title: "stack" });
  worktrees.forEach((worktree, i) =>
    upsertChunk(id, { name: `c${i + 1}`, branch: `c${i + 1}`, worktree, pr: `https://github.com/o/r/pull/${i + 1}`, status: "done" }),
  );
  return { id, dir, origin, clone, worktrees };
}

interface FakePr {
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
  head: string;
  checks: PrView["statusCheckRollup"];
  mergeable: PrView["mergeable"];
  reviewDecision: string;
  isDraft: boolean;
  view?: (count: number) => Partial<PrView>; // per-view override; count starts at 1
  viewFails?: boolean;
  views: number;
}

function fakeGh(stack: ReturnType<typeof makeStack>, count: number) {
  const prs: Record<number, FakePr> = {};
  for (let i = 1; i <= count; i++) {
    prs[i] = { state: "OPEN", base: i === 1 ? "main" : `c${i - 1}`, head: `c${i}`, checks: [], mergeable: "MERGEABLE", reviewDecision: "", isDraft: false, views: 0 };
  }
  const calls: string[] = [];
  const scratch = join(stack.dir, "scratch");
  sh(stack.dir, "clone", "-q", stack.origin, scratch);
  const originSha = (ref: string) => sh(stack.origin, "rev-parse", ref);
  const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
  const gate: { wait?: Promise<void> } = {};
  const refuse = { final: false };
  const gitCalls: string[] = [];

  const gh: Runner = async (_cmd, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      await gate.wait;
      const n = Number(args[2]!.split("/").pop());
      const pr = prs[n]!;
      pr.views++;
      if (pr.viewFails) return { code: 1, stdout: "", stderr: "boom\n" };
      const view = {
        number: n, url: args[2], state: pr.state, baseRefName: pr.base, headRefName: pr.head, headRefOid: originSha(pr.head),
        isDraft: pr.isDraft, mergeable: pr.mergeable, mergeStateStatus: "CLEAN", reviewDecision: pr.reviewDecision,
        statusCheckRollup: pr.checks, ...pr.view?.(pr.views),
      };
      return ok(JSON.stringify(view));
    }
    if (args[0] === "pr" && args[1] === "merge") {
      const n = Number(args[2]!.split("/").pop());
      calls.push(`merge ${n} ${args.includes("--merge") ? "--merge" : "--squash"}${args.includes("--admin") ? " --admin" : ""}`);
      const pr = prs[n]!;
      const want = args[args.indexOf("--match-head-commit") + 1];
      if (want !== originSha(pr.head)) return { code: 1, stdout: "", stderr: "head commit mismatch\n" };
      if (refuse.final) return { code: 1, stdout: "", stderr: "Merge commits are not allowed on this repository.\n" };
      sh(scratch, "fetch", "-q", "origin");
      sh(scratch, "checkout", "-q", "-B", pr.base, `origin/${pr.base}`);
      sh(scratch, "merge", "--no-ff", "-q", "-m", `merge #${n}`, `origin/${pr.head}`);
      sh(scratch, "push", "-q", "origin", pr.base);
      pr.state = "MERGED";
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}\n` };
  };
  let clock = 0;
  const deps: Partial<MergeDeps> = {
    run: (cmd, args, opts) => {
      if (cmd === "gh") return gh(cmd, args, opts);
      gitCalls.push(args.join(" "));
      return defaultRunner(cmd, args, opts);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    limits: DEFAULT_LIMITS,
  };
  return { prs, calls, deps, gate, refuse, gitCalls };
}

// Clears the PRs of chunks c1..cn.
const noPrs = (s: ReturnType<typeof makeStack>, n: number) => {
  for (let i = 1; i <= n; i++) upsertChunk(s.id, { name: `c${i}`, pr: undefined });
  return s;
};

// One PR per repo: only the top chunk keeps its PR.
const makeFeature = (n: number) => noPrs(makeStack(n), n - 1);

// The top PR targets main: its commits hold the whole feature.
function featureGh(stack: ReturnType<typeof makeStack>, n: number) {
  const gh = fakeGh(stack, n);
  gh.prs[n]!.base = "main";
  return gh;
}

const chunkStatuses = (id: string) => readState(id).chunks.map((c) => c.status);

const noWrites = (gh: ReturnType<typeof fakeGh>) => {
  // The merge must never rebase, push, fetch or retarget.
  expect(gh.gitCalls).toEqual([]);
};

// `pipeship pr`: real git and a local bare remote, behind a fake gh that records its calls.
function prGh() {
  const calls: string[] = [];
  const states: Record<string, string> = {}; // PR url -> state shown by `gh pr view`
  const bodies: Record<string, string> = {}; // REST path -> PR body
  const created: Record<string, RunResult> = {}; // repo name -> forced `gh pr create` result
  const listed: Record<string, string> = {}; // branch -> URL of its open PR for `gh pr list`
  let next = 10;
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== "gh") return defaultRunner(cmd, args, opts);
    calls.push(args.slice(0, args[1] === "-X" ? 3 : 2).join(" "));
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ state: states[args[2]!] ?? "OPEN" }));
    if (args[0] === "pr" && args[1] === "list") {
      const url = listed[args[args.indexOf("--head") + 1]!];
      return ok(JSON.stringify(url ? [{ url }] : []));
    }
    if (args[0] === "pr" && args[1] === "create" && created[repoName(opts.cwd)]) return created[repoName(opts.cwd)]!;
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/o/${repoName(opts.cwd)}/pull/${next++}`;
      const at = (flag: string) => args[args.indexOf(flag) + 1]!;
      calls.push(`create ${at("--head")} -> ${at("--base")}`);
      bodies[`repos/o/${repoName(opts.cwd)}/pulls/${url.split("/").pop()}`] = at("--body");
      return ok(`Creating pull request\n${url}\n`);
    }
    if (args[0] === "api" && args[1] === "-X") {
      bodies[args[3]!] = args[5]!.slice("body=".length);
      return ok();
    }
    if (args[0] === "api") return ok(bodies[args[1]!] ?? "");
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}\n` };
  };
  return { calls, states, bodies, created, listed, run };
}

test("pr: one repo pushes the top branch, opens one PR on the base and records it on the top chunk", async () => {
  const stack = noPrs(makeStack(2), 2);
  commitFile(stack.worktrees[1]!, "more.txt", "more\n", "more work");
  const gh = prGh();
  const out = await openPrs(stack.id, { title: "Feature", body: "What it does.\n" }, gh.run);
  expect(out).toEqual(["repo: opened https://github.com/o/repo/pull/10"]);
  expect(sh(stack.origin, "rev-parse", "c2")).toBe(sh(stack.clone, "rev-parse", "c2"));
  expect(gh.calls).toEqual(["pr create", "create c2 -> main"]);
  expect(readState(stack.id).chunks.map((c) => c.pr)).toEqual([undefined, "https://github.com/o/repo/pull/10"]);
  expect(gh.bodies["repos/o/repo/pulls/10"]).toBe("What it does.\n\n## Chunks\n\n- `c1` (`c1`)\n  - f1 step 0\n- `c2` (`c2`)\n  - f2 step 0\n  - more work");
});

test("pr: an open PR is only pushed, without a title", async () => {
  const stack = makeFeature(2);
  commitFile(stack.worktrees[1]!, "fix.txt", "fix\n", "fix");
  const gh = prGh();
  expect(await openPrs(stack.id, {}, gh.run)).toEqual(["repo: pushed c2, PR already open: https://github.com/o/r/pull/2"]);
  expect(gh.calls).toEqual(["pr view"]);
  expect(sh(stack.origin, "rev-parse", "c2")).toBe(sh(stack.clone, "rev-parse", "c2"));
});

test("pr: a merged or closed top PR gets a new PR, and the chunk is polled again", async () => {
  for (const [status, state] of [["merged", "MERGED"], ["closed", "CLOSED"]] as const) {
    const stack = makeFeature(1);
    upsertChunk(stack.id, { name: "c1", status });
    const gh = prGh();
    gh.states["https://github.com/o/r/pull/1"] = state;
    expect(await openPrs(stack.id, { title: "Again", body: "b" }, gh.run)).toEqual(["repo: opened https://github.com/o/repo/pull/10"]);
    expect(gh.calls).toEqual(["pr view", "pr create", "create c1 -> main"]);
    expect(readState(stack.id).chunks[0]).toMatchObject({ pr: "https://github.com/o/repo/pull/10", status: "done" });
  }
});

test("pr: two repos get two PRs linked by a Related PRs list through the REST API", async () => {
  const api = noPrs(makeStack(1, 1, "api"), 1);
  const web = noPrs(makeStack(1, 1, "web"), 1);
  const { id } = createPipeline({ repos: [{ path: api.clone, base: "main" }, { path: web.clone, base: "main" }], title: "two" });
  upsertChunk(id, { name: "a1", repo: api.clone, branch: "c1", worktree: api.worktrees[0], status: "done" });
  upsertChunk(id, { name: "w1", repo: web.clone, branch: "c1", worktree: web.worktrees[0], status: "done" });
  const gh = prGh();
  const out = await openPrs(id, { title: "Two", body: "b" }, gh.run);
  expect(out).toEqual(["api: opened https://github.com/o/api/pull/10", "web: opened https://github.com/o/web/pull/11"]);
  expect(gh.calls.filter((c) => c.startsWith("api"))).toEqual(["api -X PATCH", "api -X PATCH"]);
  expect(gh.calls.some((c) => c.startsWith("pr edit"))).toBe(false);
  expect(gh.bodies["repos/o/api/pulls/10"]).toEndWith("\n\n## Related PRs\n\n- https://github.com/o/web/pull/11\n");
  expect(gh.bodies["repos/o/web/pulls/11"]).toEndWith("\n\n## Related PRs\n\n- https://github.com/o/api/pull/10\n");

  // The web PR is merged: a new one opens, and the open api PR gets its list replaced, not doubled.
  gh.states["https://github.com/o/web/pull/11"] = "MERGED";
  gh.calls.length = 0;
  await openPrs(id, { title: "Two", body: "b" }, gh.run);
  expect(gh.calls).toEqual(["pr view", "pr view", "pr create", "create c1 -> main", "api repos/o/api/pulls/10", "api -X PATCH", "api -X PATCH"]);
  expect(gh.bodies["repos/o/api/pulls/10"]!.split("## Related PRs")).toHaveLength(2);
  expect(gh.bodies["repos/o/api/pulls/10"]).toEndWith("\n\n## Related PRs\n\n- https://github.com/o/web/pull/12\n");
});

test("pr: a repo with no remote is skipped with a message", async () => {
  const stack = noPrs(makeStack(1), 1);
  sh(stack.clone, "remote", "remove", "origin");
  const gh = prGh();
  expect(await openPrs(stack.id, { title: "T", body: "b" }, gh.run)).toEqual(["repo: no remote, skipped"]);
  expect(gh.calls).toEqual([]);
  expect(readState(stack.id).chunks[0]!.pr).toBeUndefined();
});

test("pr: a rewritten branch is pushed with the lease, and a push by someone else is refused with its cause", async () => {
  const stack = makeFeature(1);
  sh(stack.worktrees[0]!, "commit", "-q", "--amend", "-m", "f1 amended");
  const gh = prGh();
  expect(await openPrs(stack.id, {}, gh.run)).toEqual(["repo: pushed c1, PR already open: https://github.com/o/r/pull/1"]);
  expect(sh(stack.origin, "log", "-1", "--format=%s", "c1")).toBe("f1 amended");

  // Someone else pushes c1: our tracking ref is now stale, so the lease refuses to overwrite it.
  const other = join(stack.dir, "other");
  sh(stack.dir, "clone", "-q", "-b", "c1", stack.origin, other);
  commitFile(other, "theirs.txt", "theirs\n", "their work");
  sh(other, "push", "-q", "origin", "c1");
  sh(stack.worktrees[0]!, "commit", "-q", "--amend", "-m", "f1 again");
  const err = await openPrs(stack.id, {}, gh.run).catch((e: Error) => e);
  expect((err as Error).message).toMatch(/^git push c1 failed: .*\[rejected\].*stale info.*failed to push some refs/);
  expect(sh(stack.origin, "log", "-1", "--format=%s", "c1")).toBe("their work");
});

test("pr: a branch deleted on GitHub after its merge is pushed again despite the stale tracking ref", async () => {
  const stack = makeFeature(1);
  upsertChunk(stack.id, { name: "c1", status: "merged" });
  sh(stack.origin, "branch", "-q", "-D", "c1"); // GitHub deletes the head branch of a merged PR
  expect(sh(stack.clone, "rev-parse", "origin/c1")).toBe(sh(stack.clone, "rev-parse", "c1"));
  const gh = prGh();
  gh.states["https://github.com/o/r/pull/1"] = "MERGED";
  expect(await openPrs(stack.id, { title: "T", body: "b" }, gh.run)).toEqual(["repo: opened https://github.com/o/repo/pull/10"]);
  expect(sh(stack.origin, "rev-parse", "c1")).toBe(sh(stack.clone, "rev-parse", "c1"));
});

test("pr: the Chunks list starts from the remote base and leaves out chunks already merged there", async () => {
  const stack = noPrs(makeStack(2), 2);
  const other = join(stack.dir, "other");
  sh(stack.dir, "clone", "-q", stack.origin, other);
  sh(other, "push", "-q", "origin", "origin/c1:main"); // c1 merged on GitHub: the local main is behind
  const gh = prGh();
  await openPrs(stack.id, { title: "T", body: "b" }, gh.run);
  expect(gh.bodies["repos/o/repo/pulls/10"]).toBe("b\n\n## Chunks\n\n- `c2` (`c2`)\n  - f2 step 0");
});

test("pr: a PR already opened by a crashed run is recorded, from the error or from gh pr list", async () => {
  for (const withUrl of [true, false]) {
    const stack = noPrs(makeStack(1), 1);
    const gh = prGh();
    const url = "https://github.com/o/repo/pull/7";
    gh.created.repo = { code: 1, stdout: "", stderr: `a pull request for branch "c1" into branch "main" already exists:\n${withUrl ? url : ""}\n` };
    if (!withUrl) gh.listed.c1 = url;
    expect(await openPrs(stack.id, { title: "T", body: "b" }, gh.run)).toEqual([`repo: opened ${url}`]);
    expect(gh.calls).toEqual(withUrl ? ["pr create"] : ["pr create", "pr list"]);
    expect(readState(stack.id).chunks[0]!.pr).toBe(url);
  }
});

test("pr: a failed gh pr create in the second repo keeps the first PR and prints its URL", async () => {
  const api = noPrs(makeStack(1, 1, "api"), 1);
  const web = noPrs(makeStack(1, 1, "web"), 1);
  const { id } = createPipeline({ repos: [{ path: api.clone, base: "main" }, { path: web.clone, base: "main" }], title: "two" });
  upsertChunk(id, { name: "a1", repo: api.clone, branch: "c1", worktree: api.worktrees[0], status: "done" });
  upsertChunk(id, { name: "w1", repo: web.clone, branch: "c1", worktree: web.worktrees[0], status: "done" });
  const gh = prGh();
  gh.created.web = { code: 1, stdout: "", stderr: "Warning: 1 uncommitted change\n\nGraphQL: Head sha can't be blank (createPullRequest)\n" };
  const err = await openPrs(id, { title: "Two", body: "b" }, gh.run).catch((e: Error) => e);
  expect((err as Error).message).toBe(
    "api: opened https://github.com/o/api/pull/10\ngh pr create c1 failed: Warning: 1 uncommitted change | GraphQL: Head sha can't be blank (createPullRequest)",
  );
  expect(readState(id).chunks.map((c) => c.pr)).toEqual(["https://github.com/o/api/pull/10", undefined]);
  expect(gh.calls.some((c) => c.startsWith("api"))).toBe(false);
});

test("pr: a Related PRs list in a CRLF body (edited on the web) is replaced, not doubled", async () => {
  const api = noPrs(makeStack(1, 1, "api"), 1);
  const web = noPrs(makeStack(1, 1, "web"), 1);
  const { id } = createPipeline({ repos: [{ path: api.clone, base: "main" }, { path: web.clone, base: "main" }], title: "two" });
  upsertChunk(id, { name: "a1", repo: api.clone, branch: "c1", worktree: api.worktrees[0], status: "done", pr: "https://github.com/o/api/pull/3" });
  upsertChunk(id, { name: "w1", repo: web.clone, branch: "c1", worktree: web.worktrees[0], status: "merged", pr: "https://github.com/o/web/pull/4" });
  const gh = prGh();
  gh.states["https://github.com/o/web/pull/4"] = "MERGED";
  gh.bodies["repos/o/api/pulls/3"] = "Edited.\r\n\r\n## Related PRs\r\n\r\n- https://github.com/o/web/pull/4\r\n";
  await openPrs(id, { title: "Two", body: "b" }, gh.run);
  expect(gh.bodies["repos/o/api/pulls/3"]).toBe("Edited.\n\n## Related PRs\n\n- https://github.com/o/web/pull/10\n");
});

test("base: the top PR is merged into main with a merge commit, a single gh call and no git writes; every chunk becomes merged", async () => {
  const stack = makeFeature(3);
  const gh = featureGh(stack, 3);
  const before = sh(stack.origin, "rev-parse", "c3");
  await mergeRepo(stack.id, gh.deps);
  expect(gh.calls).toEqual(["merge 3 --merge"]);
  noWrites(gh);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "done", message: "merged #3 into main" });
  expect(chunkStatuses(stack.id)).toEqual(["merged", "merged", "merged"]);
  expect(sh(stack.origin, "ls-tree", "--name-only", "main").split("\n")).toEqual(["base.txt", "f1.txt", "f2.txt", "f3.txt"]);
  // initial + the 3 chunk commits + the merge commit.
  expect(sh(stack.origin, "rev-list", "--count", "main")).toBe("5");
  expect(sh(stack.origin, "rev-parse", "c3")).toBe(before);
});

const remoteBranches = (origin: string) => sh(origin, "branch", "--format=%(refname:short)").split("\n").sort();

test("base: with deleteBranches, the branch of the PR goes, the base stays", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  await mergeRepo(stack.id, gh.deps, undefined, true);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "done", message: "merged #2 into main" });
  expect(remoteBranches(stack.origin)).toEqual(["c1", "main"]);
});

test("base: without deleteBranches, the remote branches stay", async () => {
  const stack = makeStack(1);
  await mergeRepo(stack.id, fakeGh(stack, 1).deps);
  expect(remoteBranches(stack.origin)).toEqual(["c1", "main"]);
});

test("base: a branch already deleted is no error, any other failure only shows in the message", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  // c2 vanishes just before the cleanup, like a branch GitHub deleted.
  const ghRun = gh.deps.run!;
  gh.deps.run = (c, a, o) => (a[0] === "push" && a[2] === "--delete" && a[3] === "c2" ? (sh(stack.origin, "branch", "-D", "c2"), ghRun(c, a, o)) : ghRun(c, a, o));
  await mergeRepo(stack.id, gh.deps, undefined, true);
  expect(readState(stack.id).merges?.[stack.clone]?.message).toBe("merged #2 into main");
  const other = makeStack(1);
  const fake = fakeGh(other, 1);
  const run = fake.deps.run!;
  const deps = { ...fake.deps, run: (c: string, a: string[], o: { cwd: string }) => (a[0] === "push" ? Promise.resolve({ code: 1, stdout: "", stderr: "denied\n" }) : run(c, a, o)) };
  await mergeRepo(other.id, deps, undefined, true);
  expect(readState(other.id).merges?.[other.clone]).toMatchObject({ status: "done", message: "merged #1 into main; could not delete c1" });
});

test("startMerge: deleteBranches must be a boolean", () => {
  const stack = makeStack(1);
  expect(() => startMerge(stack.id, fakeGh(stack, 1).deps, undefined, "yes")).toThrow("deleteBranches must be a boolean");
});

test("merge engine: finishing the last PR archives a done pipeline, not a running one", async () => {
  const stack = makeStack(1);
  finishSteps(stack.id);
  await mergeRepo(stack.id, fakeGh(stack, 1).deps);
  expect(readState(stack.id).status).toBe("archived");
  const busy = makeStack(1);
  await mergeRepo(busy.id, fakeGh(busy, 1).deps);
  expect(readState(busy.id).status).toBe("running");
});

test("base: a failing check stops the merge, and a new run merges once it passes", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.checks = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }];
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "failed", current: "c1" });
  expect(readState(stack.id).merges?.[stack.clone]?.error).toContain("lint");
  expect(gh.calls).toEqual([]);
  expect(sh(stack.origin, "rev-list", "--count", "main")).toBe("1");

  gh.prs[1]!.checks = [];
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");
  expect(gh.calls).toEqual(["merge 1 --merge"]);
  noWrites(gh);
});

test("base: checks that stay pending stop the merge after 15 min", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]?.error).toBe("checks still running on #1 after 15 min");
  expect(gh.calls).toEqual([]);
});

test("base: a PR that targets another branch than the pipeline base merges into the branch GitHub shows", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.base = "develop";
  sh(stack.origin, "branch", "develop", "main");
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "done", message: "merged #1 into develop" });
  expect(gh.calls).toEqual(["merge 1 --merge"]);
});

test("merge: waits until GitHub computes mergeable, and gives up after 2 min", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.view = (n) => (n <= 2 ? { mergeable: "UNKNOWN" } : {});
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");

  const stuck = makeStack(1);
  const ghStuck = fakeGh(stuck, 1);
  ghStuck.prs[1]!.mergeable = "UNKNOWN";
  await mergeRepo(stuck.id, ghStuck.deps);
  expect(readState(stuck.id).merges?.[stuck.clone]?.error).toContain("after 2 min");
  expect(ghStuck.calls).toEqual([]);
});

test("merge: one job per pipeline, and nothing to merge is a 400", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  let release!: () => void;
  gh.gate.wait = new Promise((r) => (release = r));
  const { state, done } = startMerge(stack.id, gh.deps);
  expect(state.merges?.[stack.clone]?.status).toBe("running");
  expect(() => startMerge(stack.id, gh.deps)).toThrow(MergeError);
  try {
    startMerge(stack.id, gh.deps);
  } catch (err) {
    expect((err as MergeError).status).toBe(409);
  }
  release();
  await done;
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");
  try {
    startMerge(stack.id, gh.deps);
    throw new Error("expected a 400");
  } catch (err) {
    expect((err as MergeError).status).toBe(400);
  }
  expect(() => startMerge("nope-nope")).toThrow("unknown pipeline");
  const none = createPipeline({ repos: [{ path: repo }], title: "no pr" });
  expect(() => startMerge(none.id)).toThrow("no open PR");
});

test("merge: stale runs are failed unless their process is alive; delete waits for a running merge", async () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "stale" });
  const now = new Date().toISOString();
  updateState(id, (s) => {
    s.archivedAt = new Date().toISOString();
    s.merges = { [repo]: { status: "running", repo, pid: 999_999, startedAt: now, updatedAt: now } };
  });
  failStaleMerges(() => true);
  expect(readState(id).merges?.[repo]?.status).toBe("running");
  await expect(deletePipeline(id)).rejects.toThrow("wait for the merge to finish");
  failStaleMerges(() => false);
  expect(readState(id).merges?.[repo]).toMatchObject({ status: "failed" });
  expect(readState(id).merges?.[repo]?.error).toContain("interrupted");
  await deletePipeline(id);
});

test("delete: the local branches of merged chunks go, the others stay", async () => {
  const stack = makeStack(2);
  finishSteps(stack.id);
  stack.worktrees.forEach((wt) => sh(stack.clone, "worktree", "remove", "--force", wt));
  upsertChunk(stack.id, { name: "c1", status: "merged" });
  await deletePipeline(stack.id);
  expect(sh(stack.clone, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["c2", "main"]);
});

test("classifyPr: failed checks beat pending ones, BLOCKED waits for pending checks", () => {
  const pr = (over: Partial<PrView>): PrView => ({
    number: 5, url: "u", state: "OPEN", baseRefName: "main", headRefName: "h", headRefOid: "o", isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [], ...over,
  });
  const failed = { name: "lint", status: "COMPLETED", conclusion: "FAILURE" };
  const running = { name: "ci", status: "IN_PROGRESS" };
  expect(classifyPr(pr({ statusCheckRollup: [running, failed] }))).toEqual({ kind: "blocked", reason: "check failed on #5: lint" });
  expect(classifyPr(pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [running] })).kind).toBe("wait");
  expect(classifyPr(pr({ mergeStateStatus: "BLOCKED" })).kind).toBe("blocked");
  expect(classifyPr(pr({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual({ kind: "blocked", reason: "changes requested on #5" });
  expect(classifyPr(pr({ statusCheckRollup: [{ context: "x", state: "PENDING" }] })).kind).toBe("wait");
  expect(classifyPr(pr({ statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "SKIPPED" }] })).kind).toBe("ready");
});

test("merge: a STALE check run is not a failure", () => {
  const v = { number: 1, url: "u", state: "OPEN", baseRefName: "main", headRefName: "h", headRefOid: "o", isDraft: false, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "STALE" }] } as PrView;
  expect(classifyPr(v).kind).toBe("ready");
});

test("merge: a running merge is stale when its pid is dead or it stopped refreshing updatedAt", async () => {
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  const mark = (updatedAt: string) =>
    updateState(stack.id, (s) => {
      s.merges = { [stack.clone]: { status: "running", repo: stack.clone, pid: process.pid, startedAt: updatedAt, updatedAt } };
    });
  mark(new Date().toISOString());
  failStaleMerges(() => true);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("running");
  expect(() => startMerge(stack.id, gh.deps)).toThrow("already running");

  mark(old);
  failStaleMerges(() => true);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("failed");

  mark(old);
  await startMerge(stack.id, gh.deps).done; // the pid is alive but silent: no 409
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");
});

test("merge: every poll of a long wait refreshes updatedAt", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.view = (n) => (n < 5 ? { statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS" }] } : {});
  const seen: number[] = [];
  const sleep = async () => {
    seen.push(Date.parse(readState(stack.id).merges![stack.clone]!.updatedAt));
    updateState(stack.id, (s) => {
      s.merges![stack.clone]!.updatedAt = "2000-01-01T00:00:00.000Z";
    });
  };
  await mergeRepo(stack.id, { ...gh.deps, sleep });
  expect(seen).toHaveLength(4);
  expect(Math.min(...seen)).toBeGreaterThan(Date.now() - 60_000);
});

test("merge: another merge failure does not fall back to --squash", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  const run = gh.deps.run!;
  gh.deps.run = async (cmd, args, opts) =>
    args[1] === "merge" ? { code: 1, stdout: "", stderr: "GraphQL: base branch was modified\n" } : run(cmd, args, opts);
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "failed", error: "gh pr merge #2 failed: GraphQL: base branch was modified" });
});

test("merge: a failed check, a draft, a conflict or changes requested still block", async () => {
  const cases: [(pr: ReturnType<typeof fakeGh>["prs"][number]) => void, string][] = [
    [(pr) => (pr.checks = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }, { name: "ci", status: "IN_PROGRESS" }]), "check failed on #2: lint"],
    [(pr) => (pr.isDraft = true), "#2 is a draft"],
    [(pr) => (pr.mergeable = "CONFLICTING"), "#2 conflicts with main"],
    [(pr) => (pr.reviewDecision = "CHANGES_REQUESTED"), "changes requested on #2"],
    [(pr) => (pr.reviewDecision = "REVIEW_REQUIRED"), "review required on #2"],
  ];
  for (const [set, error] of cases) {
    const stack = makeFeature(2);
    const gh = featureGh(stack, 2);
    set(gh.prs[2]!);
    await mergeRepo(stack.id, gh.deps);
    expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "failed", error });
    expect(gh.calls).toEqual([]);
  }
});

test("merge: still waits while mergeable is UNKNOWN, and gives up after 2 min", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  gh.prs[2]!.view = (n) => (n <= 3 ? { mergeable: "UNKNOWN" } : {});
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");
  expect(gh.prs[2]!.views).toBeGreaterThanOrEqual(4);

  const stuck = makeFeature(2);
  const ghStuck = featureGh(stuck, 2);
  ghStuck.prs[2]!.mergeable = "UNKNOWN";
  await mergeRepo(stuck.id, ghStuck.deps);
  expect(readState(stuck.id).merges?.[stuck.clone]?.error).toContain("after 2 min");
  expect(ghStuck.calls).toEqual([]);
});

test("merge: a repo with 2 open PRs is refused with a 409 and a failed run, and nothing is merged", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  const text = stackRefusal(stack.clone, 2);
  try {
    startMerge(stack.id, gh.deps);
    throw new Error("expected a 409");
  } catch (err) {
    expect([(err as MergeError).status, (err as MergeError).message]).toEqual([409, text]);
  }
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "failed", error: text });
  expect(gh.calls).toEqual([]);
});

test("merge: Merge now during a checks wait merges with --admin at the next poll", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  gh.prs[2]!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  let sleeps = 0;
  const sleep = gh.deps.sleep!;
  gh.deps.sleep = async (ms) => {
    sleeps++;
    expect(readState(stack.id).merges?.[stack.clone]?.waitingChecks).toBe(true);
    forceMerge(stack.id, stack.clone);
    await sleep(ms);
  };
  await mergeRepo(stack.id, gh.deps);
  const run = readState(stack.id).merges?.[stack.clone];
  expect(run).toMatchObject({ status: "done", message: "merged #2 into main with --admin" });
  expect(run?.waitingChecks).toBeFalsy();
  expect(gh.calls).toEqual(["merge 2 --merge --admin"]);
  expect(sleeps).toBe(1);
});

test("merge: a failed check after Merge now still blocks", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  gh.prs[2]!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  gh.prs[2]!.view = (n) => (n > 1 ? { statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] } : {});
  const sleep = gh.deps.sleep!;
  gh.deps.sleep = async (ms) => {
    forceMerge(stack.id, stack.clone);
    await sleep(ms);
  };
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({ status: "failed", error: "check failed on #2: ci" });
  expect(gh.calls).toEqual([]);
});

test("merge: GitHub refusing the forced merge fails the run with the reason", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  gh.prs[2]!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  const sleep = gh.deps.sleep!;
  gh.deps.sleep = async (ms) => {
    forceMerge(stack.id, stack.clone);
    await sleep(ms);
  };
  const run = gh.deps.run!;
  gh.deps.run = async (cmd, args, opts) =>
    args.includes("--admin") ? { code: 1, stdout: "", stderr: "GraphQL: Must have admin rights to Repository.\n" } : run(cmd, args, opts);
  await mergeRepo(stack.id, gh.deps);
  expect(readState(stack.id).merges?.[stack.clone]).toMatchObject({
    status: "failed",
    error: "forced merge of #2 refused: GraphQL: Must have admin rights to Repository. (--admin needs admin rights on o/r)",
  });
});

test("merge: Merge now is refused when no merge waits for checks", () => {
  const stack = makeFeature(2);
  const refused = () => {
    try {
      forceMerge(stack.id, stack.clone);
    } catch (err) {
      return [(err as MergeError).status, (err as MergeError).message];
    }
  };
  expect(refused()).toEqual([409, "no merge is running"]);
  const now = new Date().toISOString();
  const run = { status: "running" as const, repo: stack.clone, pid: process.pid, startedAt: now, updatedAt: now };
  updateState(stack.id, (x) => {
    x.merges = { [stack.clone]: run };
  });
  expect(refused()).toEqual([409, "the merge is not waiting for checks"]);
  updateState(stack.id, (x) => {
    x.merges![stack.clone] = { ...run, status: "done" };
  });
  expect(refused()).toEqual([409, "no merge is running"]);
});

test("the merge route rejects a mode", async () => {
  const one = makeStack(1);
  const server = await serve(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/pipelines/${one.id}/merge`, { method: "POST", body: JSON.stringify({ mode: "base" }) });
    expect([res.status, ((await res.json()) as { error?: string }).error]).toEqual([400, "mode is no longer supported: reload the dashboard"]);
    const bad = await fetch(`http://localhost:${server.port}/api/pipelines/${one.id}/merge`, { method: "POST", body: JSON.stringify({ force: "yes" }) });
    expect([bad.status, ((await bad.json()) as { error?: string }).error]).toEqual([400, "force must be a boolean"]);
  } finally {
    server.stop(true);
  }
});

test("one PR per repo: deletePipeline removes the local branches of every chunk", async () => {
  const stack = makeFeature(2);
  finishSteps(stack.id);
  await mergeRepo(stack.id, featureGh(stack, 2).deps);
  stack.worktrees.forEach((wt) => sh(stack.clone, "worktree", "remove", "--force", wt));
  await deletePipeline(stack.id);
  const branches = sh(stack.clone, "branch", "--format=%(refname:short)").split("\n");
  expect(branches).toEqual(["main"]);
});

test("merge: the final merge does not fall back to squash when merge commits are refused", async () => {
  const stack = makeFeature(2);
  const gh = featureGh(stack, 2);
  gh.refuse.final = true;
  await mergeRepo(stack.id, gh.deps);
  const run = readState(stack.id).merges?.[stack.clone];
  expect(run?.status).toBe("failed");
  expect(run?.error).toBe('merge commits are not allowed on o/r: enable "Allow merge commits" in the GitHub settings, or merge #2 by hand');
  expect(gh.calls).toEqual(["merge 2 --merge"]);
  expect(chunkStatuses(stack.id)).toEqual(["done", "done"]);
});

test("the API adds test.md as testGuide without writing it to state.json", async () => {
  const withGuide = createPipeline({ repos: [{ path: repo }], title: "Guide", source: "text" });
  const without = createPipeline({ repos: [{ path: repo }], title: "No guide", source: "text" });
  const statePath = join(pipelineDir(withGuide.id), "state.json");
  const before = readFileSync(statePath, "utf8");
  writeFileSync(join(pipelineDir(withGuide.id), "test.md"), "# Test\n1. Open the page\n");

  const server = await serve(0);
  try {
    const list = (await (await fetch(`http://localhost:${server.port}/api/pipelines`)).json()) as { id: string; testGuide?: string }[];
    expect(list.find((p) => p.id === withGuide.id)?.testGuide).toBe("# Test\n1. Open the page\n");
    expect(list.find((p) => p.id === without.id)).not.toHaveProperty("testGuide");

    // The SSE stream carries it too.
    const res = await fetch(`http://localhost:${server.port}/api/events`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain('"testGuide":"# Test\\n1. Open the page\\n"');
  } finally {
    server.stop(true);
  }
  expect(readFileSync(statePath, "utf8")).toBe(before);
  expect(readState(withGuide.id)).not.toHaveProperty("testGuide");
});

test("setMode quick sets the mode and skips only pending quick steps; full only changes the mode", () => {
  const p = createPipeline({ repos: [{ path: repo }], title: "Switch mode", source: "text" });
  const plan = () => readState(p.id).steps.find((s) => s.name === "plan")!.status;
  setMode(p.id, "quick");
  expect(readState(p.id).mode).toBe("quick");
  expect(plan()).toBe("skipped");
  setMode(p.id, "full");
  expect(readState(p.id).mode).toBe("full");
  expect(plan()).toBe("skipped");

  const running = createPipeline({ repos: [{ path: repo }], title: "Plan running", source: "text" });
  doneBefore(running.id, "plan");
  setStep(running.id, "plan", "running");
  setMode(running.id, "quick");
  expect(readState(running.id).steps.find((s) => s.name === "plan")!.status).toBe("running");

  expect(() => setMode(p.id, "fast" as never)).toThrow("unknown mode: fast");
});

test("groupByStatus orders groups, hides empty ones and keeps the order inside a group", () => {
  const order = ["waiting_for_user", "ready", "running", "done", "failed", "stopped", "archived"];
  const items = [
    { id: "a", status: "running" },
    { id: "b", status: "archived" },
    { id: "c", status: "waiting_for_user" },
    { id: "d", status: "running" },
    { id: "e", status: "waiting_for_user" },
    { id: "f", status: "stopped" },
  ];
  const groups = groupByStatus(items, order);
  expect(groups.map((g) => g.status)).toEqual(["waiting_for_user", "running", "stopped", "archived"]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["c", "e"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["a", "d"]);
  expect(groupByStatus([], order)).toEqual([]);
});

test("groupByStatus puts an unknown status in the last group", () => {
  const groups = groupByStatus([{ status: "weird" }, { status: "ready" }, { status: "archived" }], ["ready", "archived"]);
  expect(groups.map((g) => [g.status, g.items.length])).toEqual([["ready", 1], ["archived", 2]]);
});

// --- Several repos ---

const gitRepo = (name: string, branch = "main") => {
  const dir = join(mkdtempSync(join(root, "multi-")), name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", branch);
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};

const cli = (...args: string[]) => {
  const r = spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), ...args], { encoding: "utf8", env: process.env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("old state files get repos, and chunks, merge and services get their repo", () => {
  const { id } = createPipeline({ title: "t", source: "text" });
  const path = join(pipelineDir(id), "state.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  delete old.repos;
  const now = new Date().toISOString();
  Object.assign(old, {
    repo: "/r/app",
    base: "main",
    chunks: [{ name: "c1" }],
    merge: { status: "done", mode: "base", startedAt: now, updatedAt: now },
    preview: {
      url: "u", port: 3000, log: "l", worktree: "/r/wt",
      services: [{ name: "app", kind: "front", port: 3000, url: "u", log: "l" }],
    },
  });
  writeFileSync(path, JSON.stringify(old));
  const state = readState(id);
  expect(state.repos).toEqual([{ path: "/r/app", base: "main" }]);
  expect(state).not.toHaveProperty("repo");
  expect(state).not.toHaveProperty("base");
  expect(state.chunks[0]!.repo).toBe("/r/app");
  expect(state).not.toHaveProperty("merge");
  expect(state.merges!["/r/app"]!.repo).toBe("/r/app");
  expect(state.merges!["/r/app"]).not.toHaveProperty("mode");
  expect(state.preview!.services![0]).toMatchObject({ repo: "/r/app", worktree: "/r/wt" });
  expect(state.preview).not.toHaveProperty("worktree");

  delete old.repo;
  writeFileSync(path, JSON.stringify(old));
  expect(readState(id).repos).toEqual([]);
});

test("addRepo keeps a known path as it is, and refuses a name clash", () => {
  const { id } = createPipeline({ repos: [{ path: "/x/app", base: "main" }], title: "t", source: "text" });
  expect(addRepo(id, { path: "/x/app", base: "dev" })).toMatchObject({ added: false });
  expect(readState(id).repos).toEqual([{ path: "/x/app", base: "main" }]);
  expect(addRepo(id, { path: "/x/web" }).added).toBe(true);
  expect(() => addRepo(id, { path: "/y/app" })).toThrow('repo name "app" is already used by /x/app');
  expect(() => createPipeline({ repos: [{ path: "/x/app" }, { path: "/y/app" }], title: "t" })).toThrow("already used by");
  expect(createPipeline({ repos: [{ path: "/x/app" }, { path: "/x/app" }], title: "dup" }).repos).toHaveLength(1);
});

test("cli: new takes several --repo or none, and repo adds one with its base", () => {
  const a = gitRepo("front", "main");
  const b = gitRepo("back", "develop");
  const made = JSON.parse(cli("new", "--repo", a, "--repo", b, "--title", "t", "--name", "two-repos").out);
  expect(made.repos).toEqual([
    { path: a, name: "front", base: "main", dirty: false },
    { path: b, name: "back", base: "develop", dirty: false },
  ]);
  expect(readState(made.id).repos).toEqual([{ path: a, base: "main" }, { path: b, base: "develop" }]);

  const none = JSON.parse(cli("new", "--title", "t", "--name", "no-repo").out);
  expect(none.repos).toEqual([]);
  expect(readState(none.id).repos).toEqual([]);

  writeFileSync(join(a, "untracked.txt"), "x");
  const first = JSON.parse(cli("repo", none.id, a).out);
  expect(first).toEqual({ path: a, name: "front", base: "main", dirty: true, added: true });
  expect(JSON.parse(cli("repo", none.id, a).out)).toMatchObject({ base: "main", added: false });
  expect(readState(none.id).repos).toEqual([{ path: a, base: "main" }]);
});

test("cli: repo paths are reduced to the git root, and a non-git path fails", () => {
  const a = gitRepo("root", "main");
  mkdirSync(join(a, "sub"));
  const made = JSON.parse(cli("new", "--repo", join(a, "sub"), "--repo", a, "--title", "t", "--name", "sub-new").out);
  expect(made.repos).toHaveLength(1);
  expect(readState(made.id).repos).toEqual([{ path: a, base: "main" }]);

  const none = JSON.parse(cli("new", "--title", "t", "--name", "sub-repo").out);
  const notGit = mkdtempSync(join(root, "not-git-"));
  const bad = cli("repo", none.id, notGit);
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain(`not a git repo: ${notGit}`);
  expect(JSON.parse(cli("repo", none.id, a).out)).toMatchObject({ path: a, added: true });
  expect(JSON.parse(cli("repo", none.id, join(a, "sub")).out)).toMatchObject({ path: a, added: false });
});

test("upsertChunk fills the repo for one repo, and asks for it with several", () => {
  const one = createPipeline({ repos: [{ path: "/x/app" }], title: "t", name: "chunk-one" });
  upsertChunk(one.id, { name: "c1" });
  expect(readState(one.id).chunks[0]!.repo).toBe("/x/app");

  const none = createPipeline({ title: "t", name: "chunk-none" });
  expect(() => upsertChunk(none.id, { name: "c1" })).toThrow("has no repo");

  const two = createPipeline({ repos: [{ path: "/x/app" }, { path: "/x/web" }], title: "t", name: "chunk-two" });
  expect(() => upsertChunk(two.id, { name: "c1" })).toThrow('chunk "c1": --repo is required (repos: app, web)');
  upsertChunk(two.id, { name: "c1", repo: "web" });
  upsertChunk(two.id, { name: "c2", repo: "/x/app" });
  expect(readState(two.id).chunks.map((c) => c.repo)).toEqual(["/x/web", "/x/app"]);
  upsertChunk(two.id, { name: "c1", repo: "/x/web", status: "done" });
  expect(readState(two.id).chunks[0]).toMatchObject({ repo: "/x/web", status: "done" });
  expect(() => upsertChunk(two.id, { name: "c1", repo: "app" })).toThrow('chunk "c1" belongs to web');
  expect(() => upsertChunk(two.id, { name: "c3", repo: "nope" })).toThrow("unknown repo: nope (repos: app, web)");

  const a = gitRepo("front");
  const b = gitRepo("back");
  const { id } = JSON.parse(cli("new", "--repo", a, "--repo", b, "--title", "t", "--name", "chunk-cli").out);
  expect(cli("chunk", id, "c1").err).toContain("--repo is required");
  expect(cli("chunk", id, "c1", "--repo", "back").code).toBe(0);
  expect(readState(id).chunks).toEqual([{ name: "c1", repo: b }]);
});

test("repo helpers", () => {
  expect(repoName("/home/me/shop-api/")).toBe("shop-api");
  const state = {
    repos: [{ path: "/x/a" }, { path: "/x/b" }],
    chunks: [
      { name: "a1", repo: "/x/a", worktree: "/w/a1" },
      { name: "b1", repo: "/x/b", worktree: "/w/b1" },
      { name: "a2", repo: "/x/a", worktree: "/w/a2" },
      { name: "a3", repo: "/x/a" },
      { name: "lost", repo: "/x/zzz" },
    ],
    merges: { "/x/b": { status: "running", repo: "/x/b", startedAt: "", updatedAt: "" } } as const,
  };
  expect(chunksOf(state, "/x/a").map((c) => c.name)).toEqual(["a1", "a2", "a3"]);
  expect(topChunk(state, "/x/a")!.name).toBe("a2");
  expect(topChunk(state, "/x/none")).toBeUndefined();
  expect(sharesRepo(state, { repos: [{ path: "/x/b" }] })).toBe(true);
  expect(sharesRepo(state, { repos: [{ path: "/y/b" }] })).toBe(false);
  const stacks = repoChunks(state);
  expect(stacks.map((x) => [x.name, x.chunks.length, x.merge !== undefined])).toEqual([["a", 3, false], ["b", 1, true]]);
});

test("recipe validation for several repos", () => {
  const bad = (recipe: object, repos?: string[]) => () => normalizeRecipe(recipe as never, "r.json", repos);
  const svc = { name: "a", kind: "back", start: "x" };
  const two = ["app", "web"];
  expect(bad({ services: [{ ...svc, repo: "" }] })).toThrow('service "a": "repo" must be a repo name');
  expect(bad({ services: [{ ...svc, install: 1 }] })).toThrow('service "a": "install" must be a string');
  expect(bad({ services: [{ ...svc, copyFiles: [1] }] })).toThrow('service "a": "copyFiles" must be a list of file paths');
  expect(bad({ start: "x" }, two)).toThrow('r.json: a recipe for several repos needs "services", each with a "repo"');
  expect(bad({ install: "i", services: [{ ...svc, repo: "app" }] }, two)).toThrow('top-level "install" and "copyFiles" need a single repo');
  expect(bad({ copyFiles: [".env"], services: [{ ...svc, repo: "app" }] }, two)).toThrow("need a single repo");
  expect(bad({ services: [svc] }, two)).toThrow('service "a": "repo" is required when the pipeline has several repos (app, web)');
  expect(bad({ services: [{ ...svc, repo: "nope" }] }, two)).toThrow('service "a": unknown repo "nope" (repos: app, web)');

  expect(normalizeRecipe({ services: [{ ...svc, repo: "anything", install: "i", copyFiles: [".env"] }] })[0]).toMatchObject({
    repo: "anything", install: "i", copyFiles: [".env"],
  });
  expect(normalizeRecipe({ services: [{ ...svc, repo: "app" }] }, "r.json", ["app"])[0]!.repo).toBe("app");
  expect(normalizeRecipe({ services: [svc] }, "r.json", ["app"])[0]).not.toHaveProperty("repo");
});

test("a recipe saved for several repos does not depend on their order", () => {
  expect(savedRecipePath(["/x/a", "/x/b"])).toBe(savedRecipePath(["/x/b", "/x/a"]));
  expect(savedRecipePath(["/x/a", "/x/b"])).not.toBe(savedRecipePath(["/x/a", "/x/c"]));
  expect(savedRecipePath(["/x/a"])).toBe(join(process.env.PIPESHIP_HOME!, "recipes", "x-a.json"));
});

test("a preview over two repos starts each service from its own worktree", async () => {
  const A = join(root, "pv-api");
  const B = join(root, "pv-web");
  const wtA = join(root, "pv-api-wt");
  const wtB = join(root, "pv-web-wt");
  for (const dir of [A, B, wtA, wtB]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(A, ".env"), "SECRET=1");
  const { id } = createPipeline({ repos: [{ path: A }, { path: B }], title: "t", name: "two-preview" });
  upsertChunk(id, { name: "api-1", repo: "pv-api", worktree: wtA });
  upsertChunk(id, { name: "web-1", repo: "pv-web", worktree: wtB });

  const api = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('api') })`;
  const web = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(process.cwd() + ' ' + process.env.API_URL) })`;
  const draft = join(root, "pv-draft.json");
  writeFileSync(
    draft,
    JSON.stringify({
      services: [
        { name: "web", kind: "front", repo: "pv-web", start: `bun -e "${web}"`, env: { API_URL: "http://localhost:${api.port}" } },
        { name: "api", kind: "back", repo: "pv-api", start: `bun -e "${api}"`, install: "touch installed", copyFiles: [".env"] },
      ],
    }),
  );
  const state = await startPreview(id, undefined, draft);
  try {
    const services = state.preview!.services!;
    const apiSvc = services.find((x) => x.name === "api")!;
    const webSvc = services.find((x) => x.name === "web")!;
    expect(await (await fetch(webSvc.url)).text()).toBe(`${wtB} ${apiSvc.url}`);
    expect(existsSync(join(wtA, ".env")) && existsSync(join(wtA, "installed"))).toBe(true);
    expect(existsSync(join(wtB, ".env")) || existsSync(join(wtB, "installed"))).toBe(false);
    expect(apiSvc).toMatchObject({ repo: A, worktree: wtA });
    expect(webSvc).toMatchObject({ repo: B, worktree: wtB });
    expect(previewLines(state.preview!)).toEqual([
      webSvc.url, `api (back, pv-api): ${apiSvc.url}`, `web (front, pv-web): ${webSvc.url}`,
    ]);
    expect(existsSync(savedRecipePath([B, A]))).toBe(true);
  } finally {
    await stopPipeline(id);
  }

  await expect(startPreview(id, wtA)).rejects.toThrow("several repos");
  const partial = createPipeline({ repos: [{ path: A }, { path: B }], title: "t", name: "partial-preview" });
  upsertChunk(partial.id, { name: "only-a", repo: "pv-api", worktree: wtA });
  await expect(startPreview(partial.id)).rejects.toThrow('service "web": no worktree for repo pv-web');
}, 30_000);

test("a fixed port also blocks a pipeline that shares one repo", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const x = createPipeline({ repos: [{ path: "/x/r1" }], title: "x", name: "shared-x" });
  const y = createPipeline({ repos: [{ path: "/x/r1" }, { path: "/x/r2" }], title: "y", name: "shared-y" });
  fakePreview(x.id, sleeper.pid);
  upsertChunk(y.id, { name: "c1", repo: "r1", worktree: repo });
  upsertChunk(y.id, { name: "c2", repo: "r2", worktree: repo });
  const draft = join(root, "shared-draft.json");
  writeFileSync(draft, JSON.stringify({ services: [{ name: "db", kind: "infra", repo: "r1", start: "sleep 60", fixedPort: 4997 }] }));
  try {
    await expect(startPreview(y.id, undefined, draft)).rejects.toThrow("of the repo r1 has a live preview");
  } finally {
    await stopPipeline(x.id);
    if (isAlive(sleeper.pid)) process.kill(sleeper.pid);
  }
}, 30_000);

function twoRepoStack() {
  const a = makeStack(1, 1, "merge-front");
  const b = makeStack(1, 1, "merge-back");
  const { id } = createPipeline({ repos: [{ path: a.clone, base: "main" }, { path: b.clone, base: "main" }], title: "two" });
  const pr = "https://github.com/o/r/pull/1";
  upsertChunk(id, { name: "a-c1", repo: "merge-front", branch: "c1", worktree: a.worktrees[0], pr, status: "done" });
  upsertChunk(id, { name: "b-c1", repo: "merge-back", branch: "c1", worktree: b.worktrees[0], pr, status: "done" });
  return { id, a, b };
}

test("a merge over two repos needs a repo, and merges only that repo's stack", async () => {
  const { id, a, b } = twoRepoStack();
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return [(err as MergeError).status, (err as Error).message];
    }
  };
  expect(status(() => startMerge(id, {}))).toEqual([400, "repo is required: one of merge-front, merge-back"]);
  expect(status(() => startMerge(id, {}, "nope"))?.[0]).toBe(400);
  expect(status(() => startMerge(id, {}, "nope"))?.[1]).toContain("unknown repo");
  expect(() => resolveMergeRepo(readState(id), 5)).toThrow("unknown repo");

  const ghB = fakeGh(b, 1);
  let release!: () => void;
  ghB.gate.wait = new Promise<void>((r) => (release = r));
  const { state, done } = startMerge(id, ghB.deps, "merge-back");
  expect(state.merges?.[b.clone]).toMatchObject({ status: "running", repo: b.clone });
  expect(isMergeRunning()).toBe(true);
  // Another repo of the same pipeline merges at the same time.
  const ghA = fakeGh(a, 1);
  const second = startMerge(id, ghA.deps, "merge-front");
  expect(second.state.merges?.[a.clone]?.status).toBe("running");
  expect(status(() => startMerge(id, {}, "merge-back"))).toEqual([409, "a merge is already running"]);
  await second.done;
  expect(isMergeRunning()).toBe(true); // back still runs
  release();
  await done;
  expect(isMergeRunning()).toBe(false);
  const s = readState(id);
  expect(s.merges?.[b.clone]).toMatchObject({ status: "done", repo: b.clone });
  expect(s.merges?.[a.clone]).toMatchObject({ status: "done", repo: a.clone });
  expect(s.chunks.map((c) => c.status)).toEqual(["merged", "merged"]);
  expect(ghB.calls).toEqual(["merge 1 --merge"]);
  expect(ghA.calls).toEqual(["merge 1 --merge"]);
});

test("failStaleMerges fails each stale run and keeps a live one", () => {
  const { id, a, b } = twoRepoStack();
  const now = new Date().toISOString();
  const run = (r: string, pid: number): MergeRun => ({ status: "running", repo: r, pid, startedAt: now, updatedAt: now });
  updateState(id, (s) => void (s.merges = { [a.clone]: run(a.clone, 999_999), [b.clone]: run(b.clone, 999_998) }));
  failStaleMerges(() => false);
  expect(Object.values(readState(id).merges!).map((m) => m.status)).toEqual(["failed", "failed"]);
  updateState(id, (s) => void (s.merges = { [a.clone]: run(a.clone, 1), [b.clone]: run(b.clone, 999_998) }));
  failStaleMerges((pid) => pid === 1);
  expect(readState(id).merges![a.clone]!.status).toBe("running");
  expect(readState(id).merges![b.clone]!.status).toBe("failed");
});

test("a legacy merge moves to merges, or is dropped when no repo can own it", () => {
  const legacy = (repos: string[], merge: object) => {
    const { id } = createPipeline({ repos: repos.map((path) => ({ path })), title: "t", source: "text" });
    const path = join(pipelineDir(id), "state.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), merge }));
    return readState(id);
  };
  const now = new Date().toISOString();
  const base = { status: "done", mode: "base", startedAt: now, updatedAt: now };
  const one = legacy(["/r/app"], base);
  expect(one.merges).toEqual({ "/r/app": { status: "done", repo: "/r/app", startedAt: now, updatedAt: now } });
  expect(one).not.toHaveProperty("merge");
  const two = legacy(["/r/a", "/r/b"], base);
  expect(two.merges).toBeUndefined();
  expect(two).not.toHaveProperty("merge");
  expect(legacy(["/r/a", "/r/b"], { ...base, repo: "/r/b" }).merges).toEqual({ "/r/b": { status: "done", repo: "/r/b", startedAt: now, updatedAt: now } });
});

test("delete is refused while any repo merges, and archive waits for every merge", async () => {
  const { id, a, b } = twoRepoStack();
  finishSteps(id);
  const now = new Date().toISOString();
  const run = (r: string, status: MergeRun["status"]): MergeRun => ({ status, repo: r, pid: process.pid, startedAt: now, updatedAt: now });
  updateState(id, (s) => {
    s.chunks.forEach((c) => (c.status = "merged"));
    s.merges = { [a.clone]: run(a.clone, "done"), [b.clone]: run(b.clone, "running") };
  });
  await expect(deletePipeline(id)).rejects.toThrow("wait for the merge to finish");
  expect(await archiveIfAllMerged(id)).toBe(false);
  updateState(id, (s) => void (s.merges![b.clone]!.status = "done"));
  expect(await archiveIfAllMerged(id)).toBe(true);
});

test("the merge route asks for the repo of a pipeline with several", async () => {
  const { id } = twoRepoStack();
  const server = await serve(0);
  try {
    const res = await fetch(`http://localhost:${server.port}/api/pipelines/${id}/merge`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("repo is required");
  } finally {
    await server.stop(true);
  }
});

test("delete removes the worktrees of every repo", async () => {
  const a = gitRepo("del-front");
  const b = gitRepo("del-back");
  const { id } = createPipeline({ repos: [{ path: a }, { path: b }], title: "t", name: "two-delete" });
  const wtA = join(pipelineDir(id), "worktrees", "a1");
  const wtB = join(pipelineDir(id), "worktrees", "b1");
  sh(a, "worktree", "add", "-q", "-b", "t/a1", wtA);
  sh(b, "worktree", "add", "-q", "-b", "t/b1", wtB);
  archiveNow(id);
  await deletePipeline(id);
  expect(existsSync(pipelineDir(id))).toBe(false);
  expect(sh(a, "worktree", "list")).not.toContain(wtA);
  expect(sh(b, "worktree", "list")).not.toContain(wtB);
  expect(sh(a, "branch", "--list", "t/a1")).toContain("t/a1");
  expect(sh(b, "branch", "--list", "t/b1")).toContain("t/b1");
});

// Diff API: parser, range helper, real git, route.
test("parseDiff reads modified files with exact line numbers and counts", () => {
  const [f, ...rest] = parseDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@ function one()",
      " keep",
      "-old",
      "+new",
      " tail",
      "@@ -10 +10,2 @@",
      " x",
      "+y",
      "",
    ].join("\n"),
  );
  expect(rest).toEqual([]);
  expect(f).toMatchObject({ path: "src/a.ts", oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", additions: 2, deletions: 1, binary: false });
  expect(f!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "function one()" });
  expect(f!.hunks[0]!.lines).toEqual([
    { kind: "context", text: "keep", oldNo: 1, newNo: 1 },
    { kind: "del", text: "old", oldNo: 2 },
    { kind: "add", text: "new", newNo: 2 },
    { kind: "context", text: "tail", oldNo: 3, newNo: 3 },
  ]);
  expect(f!.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
  expect(f!.hunks[1]).not.toHaveProperty("section");
  expect(f!.hunks[1]!.lines[1]).toEqual({ kind: "add", text: "y", newNo: 11 });
  expect(diffTotals([f!])).toEqual({ files: 1, additions: 2, deletions: 1 });
});

test("parseDiff handles added, deleted, renamed, binary and mode-only files", () => {
  const files = parseDiff(
    [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/p.txt b/q.txt",
      "similarity index 100%",
      "rename from p.txt",
      "rename to q.txt",
      "diff --git a/r.txt b/s.txt",
      "similarity index 80%",
      "rename from r.txt",
      "rename to s.txt",
      "--- a/r.txt",
      "+++ b/s.txt",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "Binary files /dev/null and b/img.png differ",
      "diff --git a/img2.png b/img2.png",
      "index 1..2 100644",
      "Binary files a/img2.png and b/img2.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n"),
  );
  const by = Object.fromEntries(files.map((f) => [f.newPath || f.oldPath, f]));
  expect(by["new.txt"]).toMatchObject({ status: "added", oldPath: "", path: "new.txt", additions: 2 });
  expect(by["gone.txt"]).toMatchObject({ status: "deleted", newPath: "", path: "gone.txt", deletions: 1 });
  expect(by["q.txt"]).toMatchObject({ status: "renamed", oldPath: "p.txt", path: "q.txt", similarity: 100, hunks: [] });
  expect(by["s.txt"]).toMatchObject({ status: "renamed", oldPath: "r.txt", similarity: 80, additions: 1, deletions: 1 });
  expect(by["img.png"]).toMatchObject({ status: "added", binary: true, oldPath: "" });
  expect(by["img2.png"]).toMatchObject({ status: "modified", binary: true });
  expect(by["run.sh"]).toMatchObject({ status: "modified", oldMode: "100644", newMode: "100755", hunks: [], binary: false });
});

test("parseDiff handles no-newline markers, quoted and spaced paths, truncation, and garbage", () => {
  const [a] = parseDiff(
    ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-x", "\\ No newline at end of file", "+y", "\\ No newline at end of file", ""].join("\n"),
  );
  expect(a!.hunks[0]!.lines.map((l) => l.noNewline)).toEqual([true, true]);

  const [q] = parseDiff(['diff --git "a/t\\303\\251st.txt" "b/t\\303\\251st.txt"', "new file mode 100644", "--- /dev/null", '+++ "b/t\\303\\251st.txt"', "@@ -0,0 +1 @@", "+x", ""].join("\n"));
  expect(q!.path).toBe("tést.txt");
  const [sp] = parseDiff(["diff --git a/my file.txt b/my file.txt", "--- a/my file.txt\t", "+++ b/my file.txt\t", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
  expect(sp).toMatchObject({ path: "my file.txt", oldPath: "my file.txt" });
  const [mode] = parseDiff(["diff --git a/my file.sh b/my file.sh", "old mode 100644", "new mode 100755", ""].join("\n"));
  expect(mode!.path).toBe("my file.sh");

  const big = ["diff --git a/big b/big", "--- a/big", "+++ b/big", "@@ -0,0 +1,5 @@", ..."abcde".split("").map((c) => `+${c}`), ""].join("\n");
  const [t] = parseDiff(big, { maxLinesPerFile: 3 });
  expect(t).toMatchObject({ truncated: true, hunks: [], additions: 5, deletions: 0 });

  expect(parseDiff("")).toEqual([]);
  expect(() => parseDiff("@@ nonsense\n+++\n\0\ndiff --git\n@@ -x\n \\ \n")).not.toThrow();
});

test("holdingPr gives a chunk its own PR, else the one of the first later chunk", () => {
  const c = (name: string, pr?: string) => ({ name, ...(pr && { pr }) }) as Chunk;
  expect(holdingPr([], "a")).toBeUndefined();
  // Before the PRs exist, and for an unknown chunk.
  expect(holdingPr([c("a"), c("b")], "a")).toBeUndefined();
  expect(holdingPr([c("a", "u")], "x")).toBeUndefined();
  // One PR per repo: the top chunk holds every chunk.
  expect(["a", "b", "c"].map((n) => holdingPr([c("a"), c("b"), c("c", "u3")], n))).toEqual(["u3", "u3", "u3"]);
  // Two PRs, and a chunk added after the last one.
  expect(["a", "b", "c", "d"].map((n) => holdingPr([c("a"), c("b", "u2"), c("c", "u3"), c("d")], n))).toEqual(["u2", "u2", "u3", undefined]);
});

test("openPrChunks keeps the chunks with a PR not merged, closed ones included", () => {
  const chunks = [
    { name: "a", repo: "r" },
    { name: "b", repo: "r", pr: "u1", status: "merged" },
    { name: "c", repo: "r", pr: "u2", status: "closed" },
    { name: "d", repo: "r", pr: "u3", status: "done" },
  ];
  expect(openPrChunks(chunks).map((c) => c.name)).toEqual(["c", "d"]);
});

test("diffRange follows the local chunk order, with one PR on the top chunk only", () => {
  const repo = { path: "/r/a", base: "main" };
  const chunks = [
    { name: "c1", repo: "/r/a", branch: "b1" },
    { name: "c2", repo: "/r/a", branch: "b2" },
    { name: "c3", repo: "/r/a", branch: "b3", pr: "https://github.com/o/r/pull/7" },
  ];
  const s = { repos: [repo], chunks };
  expect(diffRange(s, repo, "c1")).toEqual({ from: "main", to: "b1" });
  expect(diffRange(s, repo, "c3")).toEqual({ from: "b2", to: "b3" });
  expect(diffRange(s, repo)).toEqual({ from: "main", to: "b3" });
});

test("diffRange picks the previous branched chunk, or the base", () => {
  const repos = [{ path: "/r/a", base: "main" }, { path: "/r/b", base: "dev" }];
  const chunks = [
    { name: "c1", repo: "/r/a", branch: "b1" },
    { name: "c2", repo: "/r/a" },
    { name: "c3", repo: "/r/a", branch: "b3" },
    { name: "d1", repo: "/r/b", branch: "e1" },
    { name: "d2", repo: "/r/b" },
  ];
  const s = { repos, chunks };
  expect(diffRange(s, repos[0]!, "c1")).toEqual({ from: "main", to: "b1" });
  expect(diffRange(s, repos[0]!, "c3")).toEqual({ from: "b1", to: "b3" }); // c2 has no branch
  expect(diffRange(s, repos[0]!)).toEqual({ from: "main", to: "b3" });
  expect(diffRange(s, repos[1]!)).toEqual({ from: "dev", to: "e1" });
  expect(diffRange(s, repos[0]!, "c2")).toMatchObject({ code: "no_branch" });
  expect(diffRange(s, repos[0]!, "nope")).toMatchObject({ code: "not_found" });
  expect(diffRange(s, repos[0]!, "d1")).toMatchObject({ code: "not_found" }); // other repo
  expect(diffRange(s, repos[1]!, "c1")).toMatchObject({ code: "not_found" });
  expect(diffRange({ repos: [{ path: "/r/a" }], chunks }, { path: "/r/a" }, "c1")).toMatchObject({ code: "no_base" });
  expect(diffRange({ repos: [{ path: "/r/a" }], chunks }, { path: "/r/a" })).toMatchObject({ code: "no_base" });
  expect(diffRange({ repos: [{ path: "/r/a", base: "main" }], chunks: [{ name: "x", repo: "/r/a" }] }, { path: "/r/a", base: "main" })).toMatchObject({ code: "no_branch" });
  expect(diffRange({ repos: [{ path: "/r/a" }], chunks }, { path: "/r/a" }, "c3")).toEqual({ from: "b1", to: "b3" });
});

test("pipelineDiff runs real git per chunk and for the whole stack", async () => {
  const stack = makeStack(3);
  const names = async (chunk: string | null) => (await pipelineDiff(stack.id, null, chunk)).files.map((f) => f.path);
  expect(await names("c1")).toEqual(["f1.txt"]);
  expect(await names("c2")).toEqual(["f2.txt"]);
  const all = await pipelineDiff(stack.id, stack.clone, null);
  expect(all.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
  expect(all).toMatchObject({ chunk: null, from: "main", to: "c3", range: "origin/main...c3", additions: 3, deletions: 0, truncated: false, name: "repo" });

  // Three dots: a commit on main after the fork stays out.
  commitFile(stack.clone, "later.txt", "later\n", "later on main");
  expect((await names(null)).includes("later.txt")).toBe(false);

  // Local branch deleted, origin copy kept: falls back to origin/c1.
  sh(stack.clone, "worktree", "remove", "--force", stack.worktrees[0]!);
  sh(stack.clone, "branch", "-D", "c1");
  expect(await headRef(stack.clone, "c1")).toBe("refs/remotes/origin/c1");
  expect(await headRef(stack.clone, "c3")).toBe("refs/heads/c3");
  expect(await headRef(stack.clone, "nope")).toBeUndefined();
  expect(await baseRef(stack.clone, "c3")).toBe("refs/remotes/origin/c3");
  const viaOrigin = await pipelineDiff(stack.id, null, "c1");
  expect(viaOrigin.range).toBe("origin/main...origin/c1");
  expect(viaOrigin.files.map((f) => f.path)).toEqual(["f1.txt"]);
  expect(viaOrigin.origin).toBeNull();

  // A tag named like a branch must not win over the branch.
  sh(stack.clone, "tag", "c2", "main");
  expect((await pipelineDiff(stack.id, null, "c2")).files.map((f) => f.path)).toEqual(["f2.txt"]);

  // A branch that exists nowhere.
  upsertChunk(stack.id, { name: "ghost", branch: "feat/ghost", status: "done" });
  const err = await pipelineDiff(stack.id, null, "ghost").catch((e) => e);
  expect(err).toBeInstanceOf(DiffError);
  expect(err).toMatchObject({ status: 409, code: "missing_ref", message: 'branch "feat/ghost" not found in repo' });
});

test("pipelineDiff compares against the base on origin, not a stale local copy", async () => {
  const stack = makeStack(2);
  // Someone else pushes to main; the chunk is rebased on it, but the local main stays old.
  const other = join(stack.dir, "other");
  sh(stack.dir, "clone", "-q", stack.origin, other);
  commitFile(other, "upstream.txt", "upstream\n", "upstream change");
  sh(other, "push", "-q", "origin", "main");
  sh(stack.worktrees[0]!, "pull", "-q", "--rebase", "origin", "main");
  const res = await pipelineDiff(stack.id, null, "c1");
  expect(res.range).toBe("origin/main...c1");
  expect(res.files.map((f) => f.path)).toEqual(["f1.txt"]);
  expect(sh(stack.clone, "rev-parse", "origin/main")).toBe(sh(stack.origin, "rev-parse", "main"));

  // c1 was rebased locally: its origin copy is behind and ahead at once. c2 matches origin.
  expect(res.origin).toEqual({ ahead: 2, behind: 1 });
  expect((await pipelineDiff(stack.id, null, "c2")).origin).toEqual({ ahead: 0, behind: 0 });
  commitFile(stack.worktrees[1]!, "wip.txt", "wip\n", "not pushed");
  expect((await pipelineDiff(stack.id, null, "c2")).origin).toEqual({ ahead: 1, behind: 0 });

  // Offline: the fetch fails and the diff uses the refs already there.
  sh(stack.clone, "remote", "set-url", "origin", join(stack.dir, "gone.git"));
  expect((await pipelineDiff(stack.id, null, "c2")).files.map((f) => f.path)).toEqual(["f2.txt", "wip.txt"]);
});

test("pipelineDiff reuses a recent fetch unless forced, and shares the in-flight one", async () => {
  const stack = makeStack(1);
  const other = join(stack.dir, "other");
  sh(stack.dir, "clone", "-q", stack.origin, other);
  const before = sh(stack.clone, "rev-parse", "origin/main");
  resetFetchCache();
  const [a, b] = await Promise.all([pipelineDiff(stack.id, null, "c1"), pipelineDiff(stack.id, null, "c1")]);
  expect(a.files).toEqual(b.files);
  commitFile(other, "upstream.txt", "upstream\n", "upstream change");
  sh(other, "push", "-q", "origin", "main");
  // Within the TTL: no new fetch, so the local copy of origin/main stays where it was.
  expect((await pipelineDiff(stack.id, null, "c1")).files.map((f) => f.path)).toEqual(["f1.txt"]);
  expect(sh(stack.clone, "rev-parse", "origin/main")).toBe(before);
  const forced = await pipelineDiff(stack.id, null, "c1", undefined, { fetch: true });
  expect(sh(stack.clone, "rev-parse", "origin/main")).toBe(sh(stack.origin, "rev-parse", "main"));
  expect(forced.files.map((f) => f.path)).toEqual(["f1.txt"]);
});

test("gitDiff caps the output and cuts on a file boundary", async () => {
  const stack = makeStack(3);
  const full = await gitDiff(stack.clone, "main", "c3");
  expect(full.truncated).toBe(false);
  const cut = await gitDiff(stack.clone, "main", "c3", { maxBytes: 300, maxLinesPerFile: 3000, timeoutMs: 15_000 });
  expect(cut.truncated).toBe(true);
  expect(cut.text.length).toBeLessThan(full.text.length);
  expect(full.text.startsWith(cut.text)).toBe(true);
  const files = parseDiff(cut.text);
  expect(files.length).toBeGreaterThan(0);
  expect(files.length).toBeLessThan(3);
  for (const f of files) expect(f).toMatchObject({ additions: 1, deletions: 0 });
  const res = await pipelineDiff(stack.id, null, null, { maxBytes: 300, maxLinesPerFile: 3000, timeoutMs: 15_000 });
  expect(res.truncated).toBe(true);
});

test("the diff route answers 200, 404, 400 and 409", async () => {
  const stack = makeStack(2);
  const other = makeStack(1, 1, "other");
  const multi = createPipeline({ repos: [{ path: stack.clone, base: "main" }, { path: other.clone, base: "main" }], title: "multi" });
  upsertChunk(multi.id, { name: "m1", repo: other.clone, branch: "c1", status: "done" });
  const server = await serve(0);
  try {
    const get = async (path: string) => {
      const res = await fetch(`http://localhost:${server.port}/api/pipelines/${path}`);
      return { status: res.status, body: (await res.json()) as any };
    };
    const ok = await get(`${stack.id}/diff?chunk=c2`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ chunk: "c2", from: "c1", to: "c2", range: "origin/c1...c2", additions: 1, truncated: false });
    expect(ok.body.files[0]).toMatchObject({ path: "f2.txt", status: "added" });
    expect((await get(`${stack.id}/diff`)).body.files).toHaveLength(2);

    expect((await get("..%2Fx/diff")).status).toBe(404);
    expect(await get("nope/diff")).toEqual({ status: 404, body: { error: "unknown pipeline: nope", code: "not_found" } });
    expect((await get(`${stack.id}/diff?chunk=zzz`)).status).toBe(404);
    expect(await get(`${multi.id}/diff`)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(await get(`${multi.id}/diff?repo=nope`)).toMatchObject({ status: 400 });
    expect((await get(`${multi.id}/diff?repo=other`)).body.files.map((f: { path: string }) => f.path)).toEqual(["f1.txt"]);

    // fetch=1 forces the fetch: origin/c1 moves only then.
    const o = join(stack.dir, "other");
    sh(stack.dir, "clone", "-q", stack.origin, o);
    sh(o, "checkout", "-q", "c1");
    commitFile(o, "late.txt", "late\n", "late");
    sh(o, "push", "-q", "origin", "c1");
    const files = async (q: string) => ((await get(`${stack.id}/diff?${q}`)).body.files as { path: string }[]).map((f) => f.path);
    expect(await files("chunk=c1")).toEqual(["f1.txt"]);
    const behind = sh(stack.clone, "rev-parse", "origin/c1");
    expect(behind).not.toBe(sh(stack.origin, "rev-parse", "c1"));
    await files("chunk=c1&fetch=1");
    expect(sh(stack.clone, "rev-parse", "origin/c1")).toBe(sh(stack.origin, "rev-parse", "c1"));
    expect((await get(`${stack.id}/diff?chunk=c2&fetch=1`)).body.range).toBe("origin/c1...c2");

    upsertChunk(stack.id, { name: "ghost", branch: "feat/ghost", status: "done" });
    expect(await get(`${stack.id}/diff?chunk=ghost`)).toMatchObject({ status: 409, body: { code: "missing_ref" } });
  } finally {
    server.stop(true);
  }
});

test("parseUrl and buildSearch round-trip", () => {
  expect(parseUrl("")).toEqual({ p: null, repo: null });
  expect(parseUrl("?p=a-1&repo=/home/me/app")).toEqual({ p: "a-1", repo: "/home/me/app" });
  expect(buildSearch({ p: null, repo: null })).toBe("");
  expect(buildSearch({ p: "a-1", repo: null })).toBe("?p=a-1");
  expect(buildSearch({ p: "a-1", repo: "/home/me/app" })).toBe("?p=a-1&repo=/home/me/app");
  expect(parseUrl(buildSearch({ p: "x y", repo: "/a&b" }))).toEqual({ p: "x y", repo: "/a&b" });
  expect(buildSearch({ p: "", repo: "r" })).toBe("?repo=r");
});

test("timeAgo uses the given clock", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  expect(timeAgo("2026-01-02T00:00:00Z", now)).toBe("just now");
  expect(timeAgo("2026-01-01T23:50:00Z", now)).toBe("10 min ago");
  expect(timeAgo("2026-01-01T21:00:00Z", now)).toBe("3 h ago");
  expect(timeAgo("2025-12-30T00:00:00Z", now)).toBe("3 d ago");
  expect(timeAgoShort("2026-01-01T23:59:50Z", now)).toBe("now");
  expect(timeAgoShort("2026-01-01T23:50:00Z", now)).toBe("10m");
  expect(timeAgoShort("2026-01-01T21:00:00Z", now)).toBe("3h");
  expect(timeAgoShort("2025-12-30T00:00:00Z", now)).toBe("3d");
});

test("displaySteps shows a running step as waiting while the user is needed", () => {
  const steps = [{ name: "explore" as const, status: "done" as const }, { name: "plan" as const, status: "running" as const }];
  expect(displaySteps({ steps, status: "running" })[1]!.status).toBe("running");
  expect(displaySteps({ steps, status: "waiting_for_user", waiting: { step: "plan" } }).map((s) => s.status)).toEqual(["done", "waiting"]);
});

test("displaySteps keeps a step that runs while another waits as running", () => {
  const steps = [{ name: "review" as const, status: "running" as const }, { name: "preview" as const, status: "running" as const }];
  const out = displaySteps({ steps, status: "waiting_for_user", waiting: { step: "review", reason: "Keep the old name?" } });
  expect(out.map((s) => [s.status, s.note])).toEqual([["waiting", "Keep the old name?"], ["running", undefined]]);
});

test("allMerged and finished", () => {
  expect(allMerged({ chunks: [] })).toBe(false);
  expect(allMerged({ chunks: [{ name: "a", pr: "u", status: "merged" }] as never })).toBe(true);
  expect(allMerged({ chunks: [{ name: "a", pr: "u", status: "merged" }, { name: "b", pr: "v", status: "done" }] as never })).toBe(false);
  expect(allMerged({ chunks: [{ name: "a", pr: "u", status: "merged" }, { name: "b", pr: "v", status: "closed" }] as never })).toBe(true);
  expect(allMerged({ chunks: [{ name: "a", pr: "u", status: "closed" }] as never })).toBe(false);
  const feature = (...c: object[]) => ({ chunks: c, merged: [] as string[] }) as never as State;
  const f = feature({ name: "a", repo: "r", status: "done" }, { name: "b", repo: "r", status: "done" }, { name: "c", repo: "r", pr: "u", status: "merged" }, { name: "d", repo: "o" }, { name: "e", repo: "r", status: "coding" });
  expect(markRepoMerged(f, "r")).toEqual(["a", "b"]);
  expect(f.chunks.map((c) => c.status)).toEqual(["merged", "merged", "merged", undefined, "coding"]);
  const open = feature({ name: "a", repo: "r", status: "done" }, { name: "c", repo: "r", pr: "u", status: "done" });
  expect(markRepoMerged(open, "r")).toEqual([]);
  const closed = feature({ name: "a", repo: "r", status: "done" }, { name: "c", repo: "r", pr: "u", status: "closed" });
  expect(markRepoMerged(closed, "r")).toEqual([]);
  expect(closed.chunks.map((c) => c.status)).toEqual(["done", "closed"]);
  expect(finished({ status: "ready" })).toBe(true);
  for (const status of ["done", "failed", "stopped", "archived"] as const) expect(finished({ status })).toBe(true);
  expect(finished({ status: "running" })).toBe(false);
  expect(finished({ status: "waiting_for_user" })).toBe(false);
});

test("chunkActivity labels the chunks an agent works on", () => {
  expect(chunkActivity("coding")).toBe("Coding…");
  expect(chunkActivity("reviewing")).toBe("Reviewing…");
  expect(chunkActivity("merging")).toBe("Merging…");
  for (const status of ["done", "merged", "closed", "failed"]) expect(chunkActivity(status)).toBeUndefined();
});

test("languageOf maps extensions and file names", () => {
  expect(languageOf("src/a.ts")).toBe("typescript");
  expect(languageOf("src/a.tsx")).toBe("typescript");
  expect(languageOf("docker/Dockerfile")).toBe("bash");
  expect(languageOf("notes.unknownext")).toBeUndefined();
  expect(languageOf("README")).toBeUndefined();
});

test("highlightLines keeps one entry per line and the class of multi-line tokens", () => {
  const lines = highlightLines("/* a\n b */\nconst x = 1;", "typescript");
  expect(lines).toHaveLength(3);
  const cls = (n: unknown) => (n as { props?: { className?: string } }).props?.className;
  expect(cls(lines[0]![0])).toContain("hljs-comment");
  expect(cls(lines[1]![0])).toContain("hljs-comment");
  expect(highlightLines("a\nb", undefined)).toEqual([["a"], ["b"]]);
});

test("diffRequests: whole stack skips repos without branches, a chunk targets its repo", () => {
  const p = {
    repos: [{ path: "/r/api" }, { path: "/r/web" }],
    chunks: [
      { name: "c1", repo: "/r/api", branch: "f/c1" },
      { name: "c2", repo: "/r/web" },
    ],
  } as unknown as Parameters<typeof diffRequests>[0];
  expect(diffRequests(p, {})).toEqual([{ repo: "/r/api" }]);
  expect(diffRequests(p, { chunk: "c2" })).toEqual([{ repo: "/r/web", chunk: "c2" }]);
  expect(diffRequests(p, { chunk: "nope" })).toEqual([]);
  expect(diffUrl("a b", { repo: "/r/api", chunk: "c1" })).toBe("/api/pipelines/a%20b/diff?repo=%2Fr%2Fapi&chunk=c1");
  expect(diffUrl("a b", { repo: "/r/api", chunk: "c1" }, true)).toBe("/api/pipelines/a%20b/diff?repo=%2Fr%2Fapi&chunk=c1&fetch=1");
});

test("wait marks its step running and shows the question until the step moves on", () => {
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  doneBefore(id, "review");
  waitForUser(id, "review", "Keep the old name?");
  let state = readState(id);
  expect(state.status).toBe("waiting_for_user");
  expect(state.step).toBe("review");
  expect(state.steps.find((s) => s.name === "review")!.status).toBe("running");
  expect(state.waiting).toEqual({ step: "review", reason: "Keep the old name?" });

  setStep(id, "review", "done");
  state = readState(id);
  expect(state.status).toBe("running");
  expect(state.waiting).toBeUndefined();
  expect(() => waitForUser(id, "review")).toThrow("nothing to wait on");
});

test("formatElapsed shows seconds, minutes and hours", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  expect(formatElapsed(ago(42), now)).toBe("42s");
  expect(formatElapsed(ago(272), now)).toBe("4m32");
  expect(formatElapsed(ago(3840), now)).toBe("1h04");
});

test("displaySteps puts the question on the waiting step only", () => {
  const steps = [{ name: "explore" as const, status: "done" as const }, { name: "questions" as const, status: "running" as const }];
  const out = displaySteps({ steps, status: "waiting_for_user", waiting: { step: "questions", reason: "3 questions" } });
  expect(out.map((s) => s.note)).toEqual([undefined, "3 questions"]);
});

test("displaySteps gives a finished step the time it took", () => {
  const steps = [
    { name: "explore" as const, status: "done" as const, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:04:32Z" },
    { name: "plan" as const, status: "failed" as const, startedAt: "2026-01-01T00:05:00Z", endedAt: "2026-01-01T00:05:42Z" },
    { name: "implement" as const, status: "running" as const, startedAt: "2026-01-01T00:06:00Z" },
    { name: "review" as const, status: "skipped" as const },
  ];
  expect(displaySteps({ steps, status: "running" }).map((s) => s.duration)).toEqual(["4m32", "42s", undefined, undefined]);
});

// A done pipeline with a chunk worktree, so the preview routes can start it (no worktree argument).
function donePipeline(recipe: object) {
  const wt = mkdtempSync(join(root, "wt-"));
  writeFileSync(join(wt, ".pipeship.json"), JSON.stringify(recipe));
  const { id } = createPipeline({ repos: [{ path: repo }], title: "t", source: "text" });
  upsertChunk(id, { name: "c", branch: "c", worktree: wt });
  finishSteps(id);
  return id;
}

const SERVER = { start: 'bun -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(\'ok\') })"' };

test("preview/start makes the pipeline ready and preview/stop makes it done again", async () => {
  const id = donePipeline(SERVER);
  const server = await serve(0);
  const post = (action: string) => fetch(`http://localhost:${server.port}/api/pipelines/${id}/preview/${action}`, { method: "POST" });
  try {
    expect((await post("start")).status).toBe(202);
    for (let i = 0; i < 100 && !(readState(id).preview?.services?.every((s) => s.pid)); i++) await Bun.sleep(100);
    await Bun.sleep(300);
    const up = readState(id);
    const pid = up.preview!.services![0]!.pid!;
    expect(isAlive(pid)).toBe(true);
    for (let i = 0; i < 50 && readState(id).status !== "ready"; i++) await Bun.sleep(100);
    expect(readState(id).status).toBe("ready");
    expect(up.previewError).toBeUndefined();

    const res = await post("stop");
    expect(res.status).toBe(200);
    const stopped = readState(id);
    expect(stopped.status).toBe("done");
    expect(stopped.stopRequested).toBe(false);
    expect(stopped.preview).toBeUndefined();
    expect(isAlive(pid)).toBe(false);
  } finally {
    server.stop(true);
    await stopPreviewQuiet(id);
  }
}, 30_000);

async function stopPreviewQuiet(id: string) {
  await stopPipeline(id).catch(() => undefined);
}

test("preview/start answers 409 when not ready or already starting", async () => {
  const slow = donePipeline({ start: `bun -e "await Bun.sleep(1500); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` });
  const idle = donePipeline(SERVER);
  setStep(idle, "review", "running");
  const server = await serve(0);
  const post = async (id: string) => {
    const res = await fetch(`http://localhost:${server.port}/api/pipelines/${id}/preview/start`, { method: "POST" });
    return res.status;
  };
  try {
    expect(await post(idle)).toBe(409);
    expect(await post("nope")).toBe(404);
    expect(await post(slow)).toBe(202);
    expect(await post(slow)).toBe(409);
    const listed = (await (await fetch(`http://localhost:${server.port}/api/pipelines`)).json()) as { id: string; previewStarting?: boolean }[];
    expect(listed.find((p) => p.id === slow)?.previewStarting).toBe(true);
    expect(listed.find((p) => p.id === idle)?.previewStarting).toBeUndefined();
  } finally {
    server.stop(true);
    await stopPreviewQuiet(slow);
  }
}, 30_000);

test("a failed start records previewError and the next start clears it", async () => {
  const id = donePipeline({ start: "echo boom; exit 1" });
  await requestPreviewStart(id).done;
  expect(readState(id).previewError).toMatch(/boom/);
  expect(readState(id).status).toBe("done");

  writeFileSync(join(readState(id).chunks[0]!.worktree!, ".pipeship.json"), JSON.stringify(SERVER));
  const run = requestPreviewStart(id);
  expect(run.state.previewError).toBeUndefined();
  await run.done;
  try {
    expect(readState(id).previewError).toBeUndefined();
    expect(readState(id).preview).toBeDefined();
  } finally {
    await stopPreviewQuiet(id);
  }
}, 30_000);

test("a stop during a start is not recorded as previewError", async () => {
  const id = donePipeline({ start: `bun -e "await Bun.sleep(2000); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` });
  const run = requestPreviewStart(id);
  await Bun.sleep(500);
  await stopPreview(id);
  await run.done;
  expect(readState(id).previewError).toBeUndefined();
  expect(readState(id).preview).toBeUndefined();
  expect(readState(id).status).toBe("done");
}, 30_000);

test("archive is refused unless the pipeline is done, failed or stopped", async () => {
  const id = donePipeline(SERVER);
  const server = await serve(0);
  const post = (pid: string) => fetch(`http://localhost:${server.port}/api/pipelines/${pid}/archive`, { method: "POST" });
  try {
    setStep(id, "review", "running");
    expect((await post(id)).status).toBe(409);
    expect(readState(id).status).toBe("running");
    updateState(id, (s) => void (s.preview = previewFact()));
    setStep(id, "review", "done");
    expect((await post(id)).status).toBe(409);
    expect(readState(id).status).toBe("ready");
    updateState(id, (s) => void (s.preview = undefined));
    archiveNow(id);
    expect((await post(id)).status).toBe(409);
    expect(readState(id).status).toBe("archived");
    updateState(id, (s) => void delete s.archivedAt);
    expect((await post("nope")).status).toBe(404);
    requestStop(id);
    expect((await post(id)).status).toBe(200);
    expect(readState(id).status).toBe("archived");
  } finally {
    server.stop(true);
  }
  await expect(archivePipeline(id)).rejects.toThrow("only a done, failed or stopped");
});

test("unarchive route: 200 for an archived pipeline, 409 otherwise, 404 for an unknown id", async () => {
  const id = donePipeline(SERVER);
  const server = await serve(0);
  const post = (pid: string) => fetch(`http://localhost:${server.port}/api/pipelines/${pid}/unarchive`, { method: "POST" });
  try {
    expect((await post(id)).status).toBe(409);
    expect((await post("nope")).status).toBe(404);
    archiveNow(id);
    expect((await post(id)).status).toBe(200);
    expect(readState(id).status).toBe("done");
  } finally {
    server.stop(true);
  }
});

test("archiving a failed pipeline stops its preview", async () => {
  const id = donePipeline(SERVER);
  await requestPreviewStart(id).done;
  const pid = readState(id).preview!.services![0]!.pid!;
  expect(isAlive(pid)).toBe(true);
  setStep(id, "review", "failed");
  try {
    const archived = await archivePipeline(id);
    expect(archived.status).toBe("archived");
    expect(archived.preview).toBeUndefined();
    expect(isAlive(pid)).toBe(false);
  } finally {
    await stopPreviewQuiet(id);
  }
}, 30_000);

test("a done pipeline starts its preview, becomes ready, and is done again once the preview stops", async () => {
  const id = donePipeline(SERVER);
  try {
    await requestPreviewStart(id).done;
    expect(readState(id).status).toBe("ready");
    expect(readState(id).preview).toBeDefined();
    expect((await stopPreviewAndSettle(id)).status).toBe("done");
    expect(readState(id).preview).toBeUndefined();
  } finally {
    await stopPreviewQuiet(id);
  }
}, 30_000);

test("a stop request keeps a failed or archived pipeline's status", async () => {
  const failed = rules();
  doneBefore(failed, "review");
  setStep(failed, "review", "failed");
  expect((await stopPipeline(failed)).status).toBe("failed");
  const archived = rules();
  archiveNow(archived);
  expect((await stopPipeline(archived)).status).toBe("archived");
});

test("old state files are migrated by upgrade", () => {
  const write = (id: string, patch: object) => {
    const path = join(process.env.PIPESHIP_HOME!, "pipelines", id, "state.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  };
  const make = () => createPipeline({ repos: [{ path: repo }], title: "t", source: "text" }).id;
  const [stopped, readyIdle, readyWithPreview, archived, waiting, failedGhost] = [make(), make(), make(), make(), make(), make()];
  write(stopped, { status: "stopped", stopRequested: true });
  write(readyIdle, { status: "ready" });
  write(readyWithPreview, { status: "ready", preview: { url: "http://localhost:1", port: 1, pid: 1, log: "x", repo, worktree: repo } });
  write(archived, { status: "archived", updatedAt: "2026-01-01T00:00:00.000Z" });
  write(waiting, { status: "waiting_for_user", step: "plan", waitingFor: "Which one?" });
  write(failedGhost, { status: "failed" });
  expect(readState(stopped).status).toBe("stopped");
  expect(readState(readyIdle).status).toBe("running");
  expect(readState(readyWithPreview).status).toBe("running");
  expect(readState(archived)).toMatchObject({ status: "archived", archivedAt: "2026-01-01T00:00:00.000Z" });
  expect(readState(waiting)).toMatchObject({ status: "waiting_for_user", waiting: { step: "plan", reason: "Which one?" } });
  expect(readState(waiting)).not.toHaveProperty("waitingFor");
  expect(readState(failedGhost).status).toBe("running");
});

// The PR sync scans every pipeline in PIPESHIP_HOME: each sync test gets an empty home of its own.
function syncTest(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    const saved = process.env.PIPESHIP_HOME;
    process.env.PIPESHIP_HOME = mkdtempSync(join(root, "sync-home-"));
    try {
      await fn();
    } finally {
      process.env.PIPESHIP_HOME = saved;
    }
  });
}

// Fake gh for the PR sync: answers `pr view` from a url -> reply map and records the calls.
function syncGh(replies: Record<string, { state?: string; mergedAt?: string | null; baseRefName?: string } | "fail" | "throw" | "badjson" | "hang">) {
  const calls: string[] = [];
  const run: Runner = async (_cmd, args) => {
    const url = args[2]!;
    calls.push(url);
    const r = replies[url] ?? { state: "OPEN" };
    if (r === "throw") throw new Error("spawn gh ENOENT");
    if (r === "hang") return new Promise(() => {});
    if (r === "fail") return { code: 1, stdout: "", stderr: "not logged in\n" };
    if (r === "badjson") return { code: 0, stdout: "nope", stderr: "" };
    return { code: 0, stdout: JSON.stringify(r), stderr: "" };
  };
  return { calls, run };
}
const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;

function syncPipeline(title: string, prs: (number | undefined)[]) {
  const { id } = createPipeline({ repos: [{ path: repo, base: "main" }], title });
  prs.forEach((n, i) => upsertChunk(id, { name: `c${i + 1}`, status: "done", ...(n ? { pr: prUrl(n) } : {}) }));
  return id;
}

syncTest("pr sync: a PR merged outside pipeship sets the chunk to merged", async () => {
  const id = syncPipeline("sync merged", [101]);
  const logs: string[] = [];
  const gh = syncGh({ [prUrl(101)]: { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" } });
  const res = await syncPrStatuses({ run: gh.run, log: (l) => logs.push(l) });
  expect(res.changed).toBe(1);
  expect(chunkStatuses(id)).toEqual(["merged"]);
  expect(allMerged(readState(id))).toBe(true);
  expect(logs).toEqual([`pr sync: ${id}/c1 -> merged`]);
});

syncTest("pr sync: the last PR merged archives a done pipeline", async () => {
  const id = syncPipeline("sync archive", [111]);
  finishSteps(id);
  await syncPrStatuses({ run: syncGh({ [prUrl(111)]: { state: "MERGED" } }).run, log: () => {} });
  expect(readState(id).status).toBe("archived");
});

syncTest("pr sync: the last PR merged archives a stopped pipeline", async () => {
  const id = syncPipeline("sync archive stopped", [116]);
  requestStop(id);
  await syncPrStatuses({ run: syncGh({ [prUrl(116)]: { state: "MERGED" } }).run, log: () => {} });
  expect(readState(id).status).toBe("archived");
});

syncTest("pr sync: no auto-archive while running or while a PR is open", async () => {
  const running = syncPipeline("sync running", [112]);
  const partial = syncPipeline("sync partial", [113, 114]);
  finishSteps(partial);
  const gh = syncGh({ [prUrl(112)]: { state: "MERGED" }, [prUrl(113)]: { state: "MERGED" } });
  await syncPrStatuses({ run: gh.run, log: () => {} });
  expect(readState(running).status).toBe("running");
  expect(chunkStatuses(running)).toEqual(["merged"]);
  expect(readState(partial).status).toBe("done");
});

syncTest("pr sync: auto-archive stops the preview of a ready pipeline", async () => {
  const id = donePipeline(SERVER);
  upsertChunk(id, { name: "c", pr: prUrl(115) });
  await requestPreviewStart(id).done;
  const pid = readState(id).preview!.services![0]!.pid!;
  try {
    await syncPrStatuses({ run: syncGh({ [prUrl(115)]: { state: "MERGED" } }).run, log: () => {} });
    expect(readState(id).status).toBe("archived");
    expect(readState(id).preview).toBeUndefined();
    expect(isAlive(pid)).toBe(false);
  } finally {
    await stopPreviewQuiet(id);
  }
});

syncTest("auto-archive writes archivedAt before it stops the preview", async () => {
  const out = join(root, "state-at-sigterm.json");
  // The service copies state.json when it gets SIGTERM, so the copy shows the state at kill time.
  const id = donePipeline({ start: `trap 'cp "$STATE_FILE" "$OUT_FILE"; exit 0' TERM; ${SERVER.start} & wait` });
  process.env.STATE_FILE = join(pipelineDir(id), "state.json");
  process.env.OUT_FILE = out;
  upsertChunk(id, { name: "c", pr: prUrl(117) });
  await requestPreviewStart(id).done;
  const pid = readState(id).preview!.services![0]!.pid!;
  upsertChunk(id, { name: "c", status: "merged" });
  try {
    expect(await archiveIfAllMerged(id)).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8")).archivedAt).toBeString();
    expect(readState(id).status).toBe("archived");
    expect(readState(id).preview).toBeUndefined();
  } finally {
    delete process.env.STATE_FILE;
    delete process.env.OUT_FILE;
    await stopPreviewQuiet(id);
  }
});

syncTest("pr sync: a PR closed without merge sets closed, a reopened PR goes back to done", async () => {
  const id = syncPipeline("sync closed", [102]);
  await syncPrStatuses({ run: syncGh({ [prUrl(102)]: { state: "CLOSED", mergedAt: null } }).run, log: () => {} });
  expect(chunkStatuses(id)).toEqual(["closed"]);
  await syncPrStatuses({ run: syncGh({ [prUrl(102)]: { state: "OPEN" } }).run, log: () => {} });
  expect(chunkStatuses(id)).toEqual(["done"]);
});

syncTest("pr sync: an open PR leaves the state untouched, with no write", async () => {
  const id = syncPipeline("sync open", [103]);
  const before = readState(id).updatedAt;
  await Bun.sleep(5);
  const res = await syncPrStatuses({ run: syncGh({}).run, log: () => {} });
  expect(res).toMatchObject({ checked: 1, changed: 0, failed: 0 });
  expect(chunkStatuses(id)).toEqual(["done"]);
  expect(readState(id).updatedAt).toBe(before);
});

syncTest("pr sync: gh errors keep the state, log one line, and do not stop the other PRs", async () => {
  for (const bad of ["fail", "throw", "badjson", "hang"] as const) {
    const id = syncPipeline(`sync ${bad}`, [110, 111]);
    const logs: string[] = [];
    const gh = syncGh({ [prUrl(110)]: bad, [prUrl(111)]: { state: "MERGED" } });
    const res = await syncPrStatuses({ run: gh.run, log: (l) => logs.push(l), timeoutMs: 20 });
    expect(res.failed).toBe(1);
    expect(chunkStatuses(id)).toEqual(["done", "merged"]);
    expect(logs.filter((l) => l.includes("not checked"))).toHaveLength(1);
    updateState(id, (s) => delete s.chunks[0]!.pr); // out of the next loop
  }
});

syncTest("pr sync: no gh call for merged chunks, chunks without PR, or a running merge", async () => {
  const merged = syncPipeline("sync all merged", [120]);
  updateState(merged, (s) => (s.chunks[0]!.status = "merged"));
  syncPipeline("sync no pr", [undefined]);
  const running = syncPipeline("sync running", [121]);
  updateState(running, (s) => (s.merges = { [repo]: { status: "running", repo } as MergeRun }));
  const gh = syncGh({ [prUrl(121)]: { state: "MERGED" } });
  await syncPrStatuses({ run: gh.run, log: () => {} });
  expect(gh.calls).toEqual([]);
  expect(chunkStatuses(running)).toEqual(["done"]);
});

syncTest("pr sync: a merge on one repo does not stop the sync of the other", async () => {
  const a = join(root, "sync-a");
  const b = join(root, "sync-b");
  const { id } = createPipeline({ repos: [{ path: a }, { path: b }], title: "two repos" });
  upsertChunk(id, { name: "a1", repo: a, status: "done", pr: prUrl(140) });
  upsertChunk(id, { name: "b1", repo: b, status: "done", pr: prUrl(141) });
  updateState(id, (s) => void (s.merges = { [a]: { status: "running", repo: a } as MergeRun }));
  const gh = syncGh({ [prUrl(140)]: { state: "MERGED" }, [prUrl(141)]: { state: "CLOSED", mergedAt: null } });
  await syncPrStatuses({ run: gh.run, log: () => {} });
  expect(gh.calls).toEqual([prUrl(141)]);
  expect(chunkStatuses(id)).toEqual(["done", "closed"]);
});

syncTest("pr sync: a merge that starts while gh runs leaves the state untouched", async () => {
  const id = syncPipeline("sync merge race", [132]);
  const before = readState(id).updatedAt;
  await Bun.sleep(5);
  const run: Runner = async () => {
    updateState(id, (s) => (s.merges = { [repo]: { status: "running", repo } as MergeRun }));
    return { code: 0, stdout: JSON.stringify({ state: "MERGED" }), stderr: "" };
  };
  await syncPrStatuses({ run, log: () => {} });
  const after = readState(id);
  expect(after.chunks.map((c) => c.status)).toEqual(["done"]);
  expect(after.updatedAt).not.toBe(before); // only the test's own merge write
  const stamp = after.updatedAt;
  await Bun.sleep(5);
  await syncPrStatuses({ run: syncGh({}).run, log: () => {} });
  expect(readState(id).updatedAt).toBe(stamp);
});

syncTest("pr sync: a repeated error is logged once", async () => {
  syncPipeline("sync same error", [150]);
  const logs: string[] = [];
  const lastError = {};
  const run = syncGh({ [prUrl(150)]: "fail" }).run;
  for (let i = 0; i < 3; i++) await syncPrStatuses({ run, log: (l) => logs.push(l), lastError });
  expect(logs).toHaveLength(1);
});

syncTest("pr sync: a chunk changed while gh was running is not overwritten", async () => {
  const id = syncPipeline("sync race", [130, 131]);
  const run: Runner = async (_c, args) => {
    // While gh answers, c1 gets a new PR and c2 is merged by the merge engine.
    updateState(id, (s) => {
      s.chunks[0]!.pr = prUrl(139);
      s.chunks[1]!.status = "merged";
    });
    return { code: 0, stdout: JSON.stringify({ state: args[2] === prUrl(131) ? "CLOSED" : "MERGED" }), stderr: "" };
  };
  await syncPrStatuses({ run, log: () => {} });
  expect(chunkStatuses(id)).toEqual(["done", "merged"]);
  expect(readState(id).chunks[0]!.pr).toBe(prUrl(139));
});

syncTest("pr sync scheduler: one pass at start, no overlap, kicks are throttled", async () => {
  const id = syncPipeline("sync sched", [140]);
  let clock = 1_000_000;
  const gh = syncGh({});
  const sync = startPrSync({ run: gh.run, log: () => {}, intervalMs: 3_600_000, now: () => clock });
  sync.kick(); // a pass is running
  await sync.idle();
  const count = () => gh.calls.filter((u) => u === prUrl(140)).length;
  expect(count()).toBe(1);
  clock += 5_000;
  sync.kick();
  await sync.idle();
  expect(count()).toBe(1);
  clock += 15_000;
  sync.kick();
  await sync.idle();
  expect(count()).toBe(2);
  sync.stop();
});

syncTest("pr sync + merge: a chunk merged by the sync does not break Merge into base", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  gh.prs[2]!.state = "MERGED";
  await syncPrStatuses({ run: gh.deps.run!, log: () => {} });
  expect(chunkStatuses(stack.id)).toEqual(["done", "merged"]);
  await startMerge(stack.id, gh.deps).done;
  expect(chunkStatuses(stack.id)).toEqual(["merged", "merged"]);
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("done");
  expect(gh.calls).toEqual(["merge 1 --merge"]);
});

syncTest("pr sync: a PR merged elsewhere marks every chunk of its repo merged", async () => {
  const id = syncPipeline("sync feature", [undefined, undefined, 160]);
  finishSteps(id);
  const logs: string[] = [];
  await syncPrStatuses({ run: syncGh({ [prUrl(160)]: { state: "MERGED" } }).run, log: (l) => logs.push(l) });
  expect(chunkStatuses(id)).toEqual(["merged", "merged", "merged"]);
  expect(logs.filter((l) => l.includes("->"))).toEqual([`pr sync: ${id}/c3 -> merged`]);
  expect(readState(id).status).toBe("archived");
});

syncTest("state: chunks without a PR follow the merged PR of their repo on every read", async () => {
  const id = syncPipeline("merged on read", [undefined, 163]);
  expect(chunkStatuses(id)).toEqual(["done", "done"]);
  upsertChunk(id, { name: "c2", status: "merged" });
  expect(chunkStatuses(id)).toEqual(["merged", "merged"]);
});

syncTest("pr sync + merge: a chunk closed by the sync makes Merge fail clearly", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.state = "CLOSED";
  await syncPrStatuses({ run: gh.deps.run!, log: () => {} });
  expect(chunkStatuses(stack.id)).toEqual(["closed"]);
  await startMerge(stack.id, gh.deps).done;
  expect(readState(stack.id).merges?.[stack.clone]?.status).toBe("failed");
  expect(readState(stack.id).merges?.[stack.clone]?.error).toContain("PR #1 is closed");
});

const fakeLatest = (version: string | Error) => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    if (version instanceof Error) throw version;
    return Response.json({ version });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

test("versions compare numerically", () => {
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(shouldReload("0.10.0", "0.11.0")).toBe(true);
  expect(shouldReload("0.10.0", "0.10.0")).toBe(false);
  expect(shouldReload("0.10.0", undefined)).toBe(false);
});

test("getUpdateInfo caches the latest version for 10 minutes", async () => {
  resetUpdateCache();
  const f = fakeLatest("0.11.0");
  let t = 1_000;
  const deps = { fetch: f.fetch, now: () => t, current: "0.10.0", harness: null };
  expect(await getUpdateInfo(deps)).toEqual({ current: "0.10.0", latest: "0.11.0", available: true, harness: null });
  t += 599_000;
  await getUpdateInfo(deps);
  expect(f.calls.length).toBe(1);
  t += 2_000;
  await getUpdateInfo(deps);
  expect(f.calls.length).toBe(2);
  expect((await getUpdateInfo({ ...deps, current: "0.11.0" })).available).toBe(false);
  expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("getUpdateInfo does not throw when the network fails", async () => {
  resetUpdateCache();
  const info = await getUpdateInfo({ fetch: fakeLatest(new Error("offline")).fetch, now: () => 1, current: "0.10.0", harness: null });
  expect(info).toEqual({ current: "0.10.0", latest: null, available: false, harness: null });
});

test("installUpdate refuses with 409 while a start or merge runs, without running claude", async () => {
  const ran: string[] = [];
  const run: Runner = async (cmd, args) => (ran.push([cmd, ...args].join(" ")), { code: 0, stdout: "", stderr: "" });
  const err = await installUpdate("claude", { run, blocker: () => "A preview is starting" }).catch((e) => e);
  expect(err).toBeInstanceOf(UpdateError);
  expect([err.status, err.message]).toEqual([409, "A preview is starting"]);
  expect(ran).toEqual([]);
});

test("detectHarness reads the real path and honors the config dir overrides", () => {
  const env = { CLAUDE_CONFIG_DIR: "/home/u/.claude", CODEX_HOME: "/home/u/.codex" };
  expect(detectHarness("/home/u/.claude/plugins/cache/pipeship/pipeship/0.11.0", env)).toBe("claude");
  expect(detectHarness("/home/u/.codex/plugins/cache/pipeship/pipeship/0.11.0", env)).toBe("codex");
  expect(detectHarness("/home/u/src/pipeship", env)).toBeUndefined();
  expect(detectHarness("/opt/cc/plugins/cache/p", { CLAUDE_CONFIG_DIR: "/opt/cc" })).toBe("claude");
  expect(detectHarness("/opt/cx/plugins/cache/p", { CODEX_HOME: "/opt/cx" })).toBe("codex");
});

const codexList = (version?: string) =>
  JSON.stringify({ installed: version ? [{ pluginId: "pipeship@pipeship", name: "pipeship", marketplaceName: "pipeship", version }] : [] });

const LAST_UPDATE_CMD: Record<Harness, string> = { claude: "claude plugin update pipeship@pipeship", codex: "codex plugin add pipeship@pipeship" };

// Fake harness CLIs. Each installed version steps through its list once that harness's last update command ran ([] = not installed).
// Claude's installs are read from a file under env, Codex's from `codex plugin list`. `code` fails the running harness's commands.
function fakeHarness(harness: Harness, versions: string[], code = 0, extra: { other?: string[]; failOther?: boolean } = {}) {
  const other: Harness = harness === "claude" ? "codex" : "claude";
  const plan = { [harness]: versions, [other]: extra.other ?? [] } as Record<Harness, string[]>;
  const home = mkdtempSync(join(root, "harness-"));
  const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  const ran: string[] = [];
  const at = { claude: 0, codex: 0 };
  const writeClaude = () => {
    const v = plan.claude[at.claude];
    if (!v) return;
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, "plugins"), { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "pipeship@pipeship": [{ installPath: `/cache/${v}`, version: v }] } }));
  };
  writeClaude();
  const run: Runner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    ran.push(line);
    const h = cmd as Harness;
    if ((code && h === harness) || (extra.failOther && h === other && !line.includes("list"))) return { code: code || 1, stdout: "", stderr: "boom" };
    if (line === LAST_UPDATE_CMD[h]) (at[h] = Math.min(at[h] + 1, plan[h].length - 1), writeClaude());
    return { code: 0, stdout: line.includes("list") ? codexList(plan.codex[at.codex]) : "", stderr: "" };
  };
  return { run, env, ran };
}

const launcherOf = (harness: Harness, v: string) =>
  harness === "claude" ? `/cache/${v}/scripts/pipeship` : expect.stringMatching(new RegExp(`plugins/cache/pipeship/pipeship/${v.replace(/\./g, "\\.")}/scripts/pipeship$`));

test("codex: reads the install path from the cache layout", async () => {
  const got = await readCodexInstalled(async () => ({ code: 0, stdout: codexList("0.11.0"), stderr: "" }), { CODEX_HOME: "/h" });
  expect(got).toEqual({ installPath: "/h/plugins/cache/pipeship/pipeship/0.11.0", version: "0.11.0" });
});

test("codex: runs marketplace upgrade then add", async () => {
  const f = fakeHarness("codex", ["0.10.0", "0.11.0"]);
  await installUpdate("codex", { run: f.run, env: f.env, launcherExists: () => true });
  expect(f.ran).toEqual([
    "codex plugin list --json",
    "codex plugin marketplace upgrade pipeship",
    "codex plugin add pipeship@pipeship",
    "codex plugin list --json",
    "bun install --frozen-lockfile --production --omit=peer",
  ]);
});

describe("installUpdate dependencies", () => {
  const BUN = "bun install --frozen-lockfile --production --omit=peer";

  test("installs them in the new copy when node_modules is missing", async () => {
    const f = fakeHarness("claude", ["0.10.0", "0.11.0"]);
    const cwds: (string | undefined)[] = [];
    const run: Runner = async (cmd, args, opts) => (cmd === "bun" && cwds.push(opts?.cwd), f.run(cmd, args, opts));
    const res = await installUpdate("claude", { run, env: f.env, launcherExists: () => true, depsInstalled: () => false });
    expect(res).toMatchObject({ restarting: true });
    expect(f.ran.filter((l) => l === BUN)).toHaveLength(1);
    expect(cwds).toEqual(["/cache/0.11.0"]);
  });

  test("skips the install when node_modules exists", async () => {
    const f = fakeHarness("claude", ["0.10.0", "0.11.0"]);
    const res = await installUpdate("claude", { run: f.run, env: f.env, launcherExists: () => true, depsInstalled: () => true });
    expect(res).toMatchObject({ restarting: true });
    expect(f.ran).not.toContain(BUN);
  });

  test("does not restart when the install fails", async () => {
    const f = fakeHarness("claude", ["0.10.0", "0.11.0"]);
    const run: Runner = async (cmd, args, opts) => (cmd === "bun" ? { code: 1, stdout: "", stderr: "no network" } : f.run(cmd, args, opts));
    const res = await installUpdate("claude", { run, env: f.env, launcherExists: () => true, depsInstalled: () => false });
    expect(res).toEqual({ restarting: false, message: expect.stringContaining("no network") });
  });
});

describe.each(["claude", "codex"] as const)("installUpdate with %s", (harness) => {
  test("restarts when the install moved to a new version", async () => {
    const f = fakeHarness(harness, ["0.10.0", "0.11.0"]);
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => true });
    expect(res).toEqual({ restarting: true, launcher: launcherOf(harness, "0.11.0") });
  });

  test.each([
    ["the version did not change", ["0.10.0", "0.10.0"], true, "Already up to date"],
    ["the new version has no launcher", ["0.10.0", "0.11.0"], false, "has no launcher"],
    ["the plugin is not installed", [], true, "not installed through"],
  ])("does not restart when %s", async (_name, versions, launcher, message) => {
    const f = fakeHarness(harness, versions);
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => launcher });
    expect(res).toEqual({ restarting: false, message: expect.stringContaining(message) });
  });

  test("a failing command is a 500", async () => {
    const f = fakeHarness(harness, ["0.10.0"], 1);
    const err = await installUpdate(harness, { run: f.run, env: f.env }).catch((e) => e);
    expect([err.status, err.message]).toEqual([500, harness === "claude" ? "claude plugin update failed: boom" : "codex plugin marketplace failed: boom"]);
  });
});

describe.each(["claude", "codex"] as const)("installUpdate from %s with both harnesses installed", (harness) => {
  const other: Harness = harness === "claude" ? "codex" : "claude";

  test("updates both and restarts from the running copy", async () => {
    const f = fakeHarness(harness, ["98.0.0", "99.0.0"], 0, { other: ["98.0.0", "99.0.0"] });
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => true });
    expect(res).toEqual({ restarting: true, launcher: launcherOf(harness, "99.0.0"), warning: undefined });
    expect(f.ran).toContain(LAST_UPDATE_CMD[harness]);
    expect(f.ran).toContain(LAST_UPDATE_CMD[other]);
  });

  test("restarts from the other copy when only it moved to a newer version", async () => {
    const f = fakeHarness(harness, ["99.0.0", "99.0.0"], 0, { other: ["98.0.0", "99.0.0"] });
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => true });
    expect(res).toEqual({ restarting: true, launcher: launcherOf(other, "99.0.0"), warning: undefined });
  });

  test("does not restart when only the other copy moved to a version not newer than the running one", async () => {
    const f = fakeHarness(harness, ["0.0.1", "0.0.1"], 0, { other: ["0.0.1", "0.0.2"] });
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => true });
    expect(res).toEqual({ restarting: false, message: expect.stringContaining(`Updated ${other}`) });
  });

  test("a failing other copy does not block the running one, and is reported", async () => {
    const f = fakeHarness(harness, ["98.0.0", "99.0.0"], 0, { other: ["98.0.0", "99.0.0"], failOther: true });
    const res = await installUpdate(harness, { run: f.run, env: f.env, launcherExists: () => true });
    expect(res).toMatchObject({ restarting: true, warning: expect.stringContaining("failed: boom") });
  });
});

test("a copy outside a plugin manager gets a message and runs no command", async () => {
  const f = fakeHarness("codex", []);
  const res = await installUpdate(null, { run: f.run, env: f.env });
  expect(res).toEqual({ restarting: false, message: expect.stringContaining("not installed through a plugin manager") });
  expect(f.ran).toEqual([]);
});

test("POST /api/update/install does not restart when nothing changed, and /api/health has the version", async () => {
  const f = fakeHarness("claude", ["1", "1"]);
  const server = await serve(0, { harness: "claude", update: { run: f.run, env: f.env, launcherExists: () => true } });
  try {
    const base = `http://localhost:${server.port}`;
    expect(((await (await fetch(`${base}/api/health`)).json()) as { version: string }).version).toBe(currentVersion());
    const res = await fetch(`${base}/api/update/install`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { restarting: boolean }).restarting).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("updateInPlace reports where the new version is, or why nothing changed", async () => {
  const restart = { restarting: true as const, launcher: "/cache/2.0.0/scripts/pipeship" };
  expect(await updateInPlace(async () => restart)).toBe("Updated: the next pipeship command runs the new version from /cache/2.0.0");
  expect(await updateInPlace(async () => ({ restarting: false, message: "Already up to date" }))).toBe("Already up to date");
});

describe("requestDashboardUpdate", () => {
  // A fake dashboard: install answers `install`, health reports each version of `versions` in turn, then is down.
  const fakeDashboard = (install: { status?: number; body: object }, versions: string[] = []) => ({
    sleep: async () => {},
    fetch: (async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname === "/api/update/install") return Response.json(install.body, { status: install.status ?? 200 });
      const version = versions.shift();
      if (version === undefined) throw new Error("down");
      return Response.json({ app: "pipeship", version });
    }) as typeof fetch,
  });

  test("waits for the restarted dashboard to report a new version", async () => {
    const deps = fakeDashboard({ body: { restarting: true, from: "1.0.0" } }, ["1.0.0", "2.0.0"]);
    expect(await requestDashboardUpdate(4400, deps)).toBe("Updated from 1.0.0 to 2.0.0: the dashboard restarted on http://localhost:4400");
  });

  test("relays a message and an error", async () => {
    expect(await requestDashboardUpdate(4400, fakeDashboard({ body: { restarting: false, message: "Already up to date" } }))).toBe("Already up to date");
    const busy = fakeDashboard({ status: 409, body: { error: "A merge is running: wait for it, then update" } });
    await expect(requestDashboardUpdate(4400, busy)).rejects.toThrow("A merge is running");
  });

  test("fails when the dashboard does not come back", async () => {
    const deps = fakeDashboard({ body: { restarting: true, from: "1.0.0" } });
    await expect(requestDashboardUpdate(4400, { ...deps, waitMs: 5 })).rejects.toThrow("did not come back");
  });
});

describe("isTestFile", () => {
  test("matches test files, snapshots and test folders", () => {
    for (const p of ["a.test.ts", "src/a.spec.tsx", "x/b.test.js", "src/__tests__/a.ts", "__mocks__/m.ts", "a.snap", "pkg/foo_test.go", "test_a.py", "x/a_test.py", "test/helper.ts", "tests/a.ts", "spec/a.rb"]) {
      expect(isTestFile(p)).toBe(true);
    }
  });
  test("keeps source, lockfiles, package.json and build output", () => {
    for (const p of ["src/a.ts", "package.json", "web/package.json", "node_modules/x/index.js", "vendor/a.go", "dist/a.js", "bun.lock", "web/package-lock.json", "yarn.lock", "src/contest.ts", "src/latest/a.ts", "README.md"]) {
      expect(isTestFile(p)).toBe(false);
    }
  });
});

describe("buildFileTree", () => {
  const f = (path: string, status: "added" | "deleted" | "modified" | "renamed" = "modified") =>
    ({ path, oldPath: path, newPath: path, status, binary: false, additions: 1, deletions: 0, hunks: [] }) as import("../src/diff.ts").DiffFile;
  // Compact view: folders as `name/` with their children, files as `name`.
  const shape = (nodes: TreeNode[]): unknown[] =>
    nodes.map((n) => (n.kind === "file" ? n.name : { [`${n.name}/`]: shape(n.children) }));

  test("nests folders, puts folders before files and sorts by name", () => {
    const tree = buildFileTree([f("z.ts"), f("src/b.ts"), f("README.md"), f("src/a/x.ts"), f("src/a/y.ts"), f("lib/q.ts")]);
    expect(shape(tree)).toEqual([{ "lib/": ["q.ts"] }, { "src/": [{ "a/": ["x.ts", "y.ts"] }, "b.ts"] }, "README.md", "z.ts"]);
  });
  test("merges a chain of single-folder parents and keeps the full path of the last folder", () => {
    const tree = buildFileTree([f("src/dashboard/components/a.tsx"), f("src/dashboard/components/b.tsx")]);
    expect(shape(tree)).toEqual([{ "src/dashboard/components/": ["a.tsx", "b.tsx"] }]);
    expect(tree[0]!.path).toBe("src/dashboard/components");
  });
  test("does not merge a folder that also holds a file", () => {
    const tree = buildFileTree([f("a/x.ts"), f("a/b/c/y.ts")]);
    expect(shape(tree)).toEqual([{ "a/": [{ "b/c/": ["y.ts"] }, "x.ts"] }]);
  });
  test("keeps the file for status and rename display", () => {
    const file = { ...f("new/n.ts", "renamed"), oldPath: "old/n.ts" };
    const node = buildFileTree([file])[0]!;
    expect(node.kind === "dir" && node.children[0]).toMatchObject({ kind: "file", name: "n.ts", path: "new/n.ts", file });
  });
});
