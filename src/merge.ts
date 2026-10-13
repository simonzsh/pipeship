import { isAlive } from "./preview.ts";
import { chunksOf, repoName } from "./repos.ts";
import { listStates, lookupRepo, MERGED, readState, updateState, upsertChunk, type Chunk, type MergeMode, type MergeRun, type Repo, type State } from "./state.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<RunResult>;
export interface MergeLimits {
  mergeableMs: number;
  checksMs: number;
  pollMs: number;
}
export interface MergeDeps {
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  limits: MergeLimits;
}

export const DEFAULT_LIMITS: MergeLimits = { mergeableMs: 120_000, checksMs: 900_000, pollMs: 10_000 };

// Async on purpose: a sync spawn would freeze the dashboard's SSE stream during a slow gh call.
export const defaultRunner: Runner = async (cmd, args, { cwd }) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

export class MergeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface PrView {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: string;
  statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[];
}
export type Verdict =
  | { kind: "ready" }
  | { kind: "wait"; reason: string; pendingChecks: boolean }
  | { kind: "blocked"; reason: string; transient?: true }; // transient: may clear once CI starts

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a PR URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

type Check = PrView["statusCheckRollup"][number];
// A CheckRun has `status`/`conclusion`; a StatusContext has `context`/`state`.
const isContext = (c: Check) => c.context !== undefined || c.state !== undefined;
const checkName = (c: Check) => c.name ?? c.context ?? "unnamed check";
const failed = (c: Check) =>
  isContext(c)
    ? c.state === "FAILURE" || c.state === "ERROR"
    : c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED", "STALE"].includes(c.conclusion ?? "");
const pending = (c: Check) => (isContext(c) ? c.state === "PENDING" || c.state === "EXPECTED" : c.status !== "COMPLETED");

export function classifyPr(v: PrView): Verdict {
  const n = v.number;
  const checks = v.statusCheckRollup ?? [];
  if (v.isDraft) return { kind: "blocked", reason: `#${n} is a draft` };
  if (v.mergeable === "CONFLICTING" || v.mergeStateStatus === "DIRTY") {
    return { kind: "blocked", reason: `#${n} conflicts with ${v.baseRefName}` };
  }
  const bad = checks.filter(failed);
  if (bad.length) return { kind: "blocked", reason: `check failed on #${n}: ${bad.map(checkName).join(", ")}` };
  if (v.reviewDecision === "CHANGES_REQUESTED") return { kind: "blocked", reason: `changes requested on #${n}` };
  if (v.reviewDecision === "REVIEW_REQUIRED") return { kind: "blocked", reason: `review required on #${n}` };
  if (v.mergeable === "UNKNOWN") return { kind: "wait", reason: `waiting for GitHub to check #${n}`, pendingChecks: false };
  const waiting = checks.filter(pending);
  if (waiting.length) {
    return { kind: "wait", reason: `waiting for checks on #${n} (${waiting.length} pending)`, pendingChecks: true };
  }
  // BLOCKED is normal while required checks run, so it is tested after the pending checks.
  if (v.mergeStateStatus === "BLOCKED") return { kind: "blocked", reason: `merge blocked by branch protection on #${n}`, transient: true };
  return { kind: "ready" };
}

// No mode picks by open PR count; any other value is a client bug, not a default.
export function resolveMergeMode(raw: unknown, open: number): MergeMode {
  if (raw === undefined || raw === null) return open >= 2 ? "combine" : "base";
  if (raw === "combine" || raw === "base") return raw;
  throw new MergeError("unknown merge mode", 400);
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Pipeline ids with a merge job in this process.
const active = new Set<string>();

// The engine refreshes updatedAt at every poll, so a silent run is dead even if its pid was reused.
const STALE_MS = 5 * 60_000;
const isStale = (m: MergeRun | undefined, alive: (pid: number) => boolean) =>
  m?.status === "running" && (m.pid === undefined || !alive(m.pid) || Date.now() - Date.parse(m.updatedAt) > STALE_MS);

function runningMerge(mode: MergeMode, repo: string, startedAt: string): MergeRun {
  return { status: "running", mode, repo, pid: process.pid, message: "starting", startedAt, updatedAt: new Date().toISOString() };
}

// The repo whose stack to merge: optional with one repo, required with several.
export function resolveMergeRepo(state: State, raw: unknown): Repo {
  const { repos } = state;
  if (raw === undefined || raw === null) {
    if (repos.length === 1) return repos[0]!;
    if (repos.length === 0) throw new MergeError("no open PR to merge", 400);
    throw new MergeError(`repo is required: one of ${repos.map((r) => repoName(r.path)).join(", ")}`, 400);
  }
  if (typeof raw !== "string") throw new MergeError("unknown repo", 400);
  try {
    return lookupRepo(state, raw);
  } catch (err) {
    throw new MergeError(errorMessage(err), 400);
  }
}

export function startMerge(
  id: string,
  deps: Partial<MergeDeps> = {},
  rawMode?: unknown,
  rawRepo?: unknown,
): { state: State; done: Promise<void> } {
  let s: State;
  try {
    s = readState(id);
  } catch (err) {
    throw new MergeError(errorMessage(err), 404);
  }
  if (active.has(id) || (s.merge?.status === "running" && !isStale(s.merge, isAlive))) {
    throw new MergeError("a merge is already running", 409);
  }
  const repo = resolveMergeRepo(s, rawRepo);
  const open = chunksOf(s, repo.path).filter((c) => c.pr && c.status !== MERGED).length;
  if (open === 0) throw new MergeError("no open PR to merge", 400);
  const mode = resolveMergeMode(rawMode, open);
  if (mode === "combine" && open < 2) throw new MergeError("only one open PR: use Merge", 400);
  if (mode === "base" && open > 1) throw new MergeError("combine the PRs first", 400);

  active.add(id);
  updateState(id, (x) => {
    x.merge = runningMerge(mode, repo.path, new Date().toISOString());
  });
  const done = mergeStack(id, deps, mode, repo.path).finally(() => active.delete(id));
  return { state: readState(id), done };
}

// A merge whose dashboard died stays "running" forever: mark it failed so the user can resume.
export function failStaleMerges(alive: (pid: number) => boolean = isAlive): void {
  for (const s of listStates()) {
    if (!isStale(s.merge, alive)) continue;
    updateState(s.id, (x) => {
      const now = new Date().toISOString();
      x.merge = {
        ...x.merge!,
        status: "failed",
        error: "interrupted: the dashboard stopped; click Merge stack to resume",
        updatedAt: now,
        endedAt: now,
      };
    });
  }
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

// What the merge steps share: gh access, state writes and the wait-until-mergeable loop.
interface Ctx {
  id: string;
  repo: string;
  d: MergeDeps;
  gh: (args: string[]) => Promise<RunResult>;
  view: (url: string) => Promise<PrView>;
  progress: (c: Chunk, message: string) => void;
  finish: (message: string) => void;
  mergePr: (c: Chunk, head: string, method: "merge" | "squash", message: string) => Promise<void>;
  waitReady: (c: Chunk, first: PrView, expectedHead: string, pushed: boolean, reuseFirst: boolean) => Promise<PrView>;
}

function makeCtx(id: string, repo: string, d: MergeDeps): Ctx {
  const iso = () => new Date().toISOString();
  // Short read-modify-write: the skill and the CLI write the same file while we wait.
  const write = (fields: Partial<MergeRun>) =>
    updateState(id, (s) => {
      s.merge = { ...s.merge!, ...fields, updatedAt: iso() };
    });
  const progress = (c: Chunk, message: string) => write({ current: c.name, message });
  const finish = (message: string) => write({ status: "done", current: undefined, message, endedAt: iso() });
  const gh = (args: string[]) => d.run("gh", args, { cwd: repo });
  const view = async (url: string): Promise<PrView> => {
    const fields = "number,url,state,baseRefName,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
    const r = await gh(["pr", "view", url, "--json", fields]);
    if (r.code !== 0) throw new Error(`gh pr view failed: ${firstLine(r.stderr)}`);
    return JSON.parse(r.stdout) as PrView;
  };

  const mergePr: Ctx["mergePr"] = async (c, head, method, message) => {
    const url = c.pr!;
    const n = parsePrUrl(url).number;
    // No -d: the remote branches stay.
    const args = (kind: string) => ["pr", "merge", url, kind, "--match-head-commit", head];
    let r = await gh(args(method === "merge" ? "--merge" : "--squash"));
    // Squash is the fallback only when the repo refuses merge commits, not for any other failure.
    if (method === "merge" && r.code !== 0 && /merge commits are not allowed/i.test(r.stderr)) r = await gh(args("--squash"));
    if (r.code !== 0) throw new Error(`gh pr merge #${n} failed: ${firstLine(r.stderr)}`);
    upsertChunk(id, { name: c.name, status: MERGED });
    progress(c, message);
  };

  // Just after a fold, CI has not queued yet: "no checks" and "blocked" are not final answers.
  // `first` is reused for the first poll unless the PR changed since it was read (a fold).
  const waitReady: Ctx["waitReady"] = async (c, first, expectedHead, pushed, reuseFirst) => {
    const url = c.pr!;
    const n = parsePrUrl(url).number;
    let v = first;
    const hadChecks = v.statusCheckRollup.length > 0;
    const t0 = d.now();
    let checksSince: number | undefined;
    for (let reuse = reuseFirst; ; reuse = false) {
      if (!reuse) v = await view(url);
      let verdict = classifyPr(v);
      if (pushed && d.now() - t0 <= d.limits.mergeableMs) {
        const unseen = v.headRefOid !== expectedHead;
        const noChecks = hadChecks && v.statusCheckRollup.length === 0;
        if (unseen || (verdict.kind === "ready" && noChecks) || (verdict.kind === "blocked" && verdict.transient)) {
          verdict = { kind: "wait", reason: `waiting for checks to start on #${n}`, pendingChecks: false };
        }
      }
      if (verdict.kind === "ready") break;
      if (verdict.kind === "blocked") throw new Error(verdict.reason);
      if (verdict.pendingChecks) {
        checksSince ??= d.now();
        if (d.now() - checksSince > d.limits.checksMs) throw new Error(`checks still running on #${n} after 15 min`);
      } else if (d.now() - t0 > d.limits.mergeableMs) {
        throw new Error(`GitHub has not computed whether #${n} can merge after 2 min`);
      }
      progress(c, verdict.reason);
      await d.sleep(d.limits.pollMs);
    }
    return v;
  };

  return { id, repo, d, gh, view, progress, finish, mergePr, waitReady };
}

// Appends the folded PRs to the bottom PR's description, once each.
async function listFoldedPrs(x: Ctx, bottom: Chunk, folded: string[]): Promise<void> {
  if (!folded.length) return;
  const bottomUrl = bottom.pr!;
  const bn = parsePrUrl(bottomUrl);
  x.progress(bottom, `updating the description of #${bn.number}`);
  const fail = (why: string) =>
    new Error(`could not update the description of #${bn.number}: ${why}. The PRs are combined; edit the description by hand.`);
  const got = await x.gh(["pr", "view", bottomUrl, "--json", "body"]);
  if (got.code !== 0) throw fail(firstLine(got.stderr));
  const body: string = (JSON.parse(got.stdout) as { body?: string }).body ?? "";
  // Exact match: .../pull/1 must not count as listed because .../pull/12 is.
  const todo = folded.filter((u) => !new RegExp(`${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(body));
  if (!todo.length) return;
  const line = `Combines ${todo.map((u) => `#${parsePrUrl(u).number}`).join(", ")} (merged into this branch):\n${todo.map((u) => `- ${u}`).join("\n")}`;
  const patch = await x.gh(["api", "-X", "PATCH", `repos/${bn.owner}/${bn.repo}/pulls/${bn.number}`, "-f", `body=${body.trimEnd()}\n\n${line}\n`]);
  if (patch.code !== 0) throw fail(firstLine(patch.stderr));
}

// Combine: fold each PR into the branch of the PR below, top first. No rebase, retarget or push:
// origin and the base branch stay untouched, and the bottom PR collects the whole stack.
async function combine(x: Ctx, chunks: Chunk[]): Promise<void> {
  const views = await Promise.all(chunks.map((c) => x.view(c.pr!)));
  const closed = views.find((v) => v.state === "CLOSED");
  if (closed) throw new Error(`PR #${closed.number} is closed`);
  chunks.forEach((c, i) => views[i]!.state === "MERGED" && upsertChunk(x.id, { name: c.name, status: MERGED }));
  const bottom = views.findIndex((v) => v.state === "OPEN");
  if (bottom < 0) throw new Error("no open PR to combine");
  const top = views.findLastIndex((v) => v.state === "OPEN");

  // Tip of the branch that the last fold went into: GitHub shows it on the next PR only after a delay.
  let foldTip: string | undefined;
  for (let i = top; i > bottom; i--) {
    const c = chunks[i]!;
    const below = views[i - 1]!;
    const n = parsePrUrl(c.pr!).number;
    x.progress(c, `checking #${n}`);
    // The first step reuses the view read above; later ones follow a fold, so they need a fresh one.
    const first = i === top ? views[i]! : await x.view(c.pr!);
    if (first.baseRefName !== below.headRefName) throw new Error(`PR #${n} targets ${first.baseRefName}, not ${below.headRefName}`);
    const v = await x.waitReady(c, first, foldTip ?? first.headRefOid, foldTip !== undefined, i === top);

    await x.mergePr(c, v.headRefOid, "merge", `combined #${n} into ${below.headRefName}`);
    const tip = await x.d.run("git", ["ls-remote", "origin", `refs/heads/${below.headRefName}`], { cwd: x.repo });
    foldTip = tip.stdout.split(/\s/)[0];
    if (tip.code !== 0 || !foldTip) throw new Error(`could not read the new head of ${below.headRefName}: ${firstLine(tip.stderr)}`);
  }

  // Every PR above the bottom one is merged now, including those from an earlier run.
  const folded = chunks.slice(bottom + 1).map((c) => c.pr!);
  await listFoldedPrs(x, chunks[bottom]!, folded);
  x.finish(`combined ${folded.length + 1} PRs into #${parsePrUrl(chunks[bottom]!.pr!).number}`);
}

// Base: squash-merge the single PR left into the base branch. No rebase, push or retarget:
// combine already put the whole stack on this PR's branch.
async function mergeIntoBase(x: Ctx, repo: Repo, chunks: Chunk[]): Promise<void> {
  const open = chunks.filter((c) => c.status !== MERGED);
  if (open.length !== 1) throw new Error(open.length ? "combine the PRs first" : "no open PR to merge");
  const c = open[0]!;
  const n = parsePrUrl(c.pr!).number;
  x.progress(c, `checking #${n}`);
  const v = await x.view(c.pr!);
  if (v.state === "CLOSED") throw new Error(`PR #${n} is closed`);
  const base = repo.base ?? v.baseRefName;
  if (v.baseRefName !== base) throw new Error(`PR #${n} targets ${v.baseRefName}, not ${base}: retarget it or combine first`);
  if (v.state === "MERGED") upsertChunk(x.id, { name: c.name, status: MERGED });
  else {
    await x.waitReady(c, v, v.headRefOid, false, true);
    await x.mergePr(c, v.headRefOid, "squash", `merged #${n}`);
  }
  x.finish(`merged #${n} into ${base}`);
}

// Never throws: every failure ends up in state.merge. `repo` is a path or a name.
export async function mergeStack(
  id: string,
  deps: Partial<MergeDeps> = {},
  mode: MergeMode = "combine",
  repoRef?: string,
): Promise<void> {
  const d: MergeDeps = {
    run: defaultRunner,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    limits: DEFAULT_LIMITS,
    ...deps,
  };
  let repoPath = "";
  try {
    const s = readState(id);
    const repo = repoRef === undefined ? resolveMergeRepo(s, undefined) : lookupRepo(s, repoRef);
    repoPath = repo.path;
    const startedAt = s.merge?.status === "running" ? s.merge.startedAt : new Date().toISOString();
    updateState(id, (x) => {
      x.merge = runningMerge(mode, repo.path, startedAt);
    });
    const x = makeCtx(id, repo.path, d);
    const chunks = chunksOf(s, repo.path).filter((c) => c.pr);
    await (mode === "combine" ? combine(x, chunks) : mergeIntoBase(x, repo, chunks));
  } catch (err) {
    try {
      updateState(id, (s) => {
        const now = new Date().toISOString();
        const run = s.merge ?? runningMerge(mode, repoPath, now);
        s.merge = { ...run, status: "failed", error: errorMessage(err), endedAt: now, updatedAt: now };
      });
    } catch {
      // The state file is gone (pipeline deleted): nothing left to report to.
    }
  }
}
