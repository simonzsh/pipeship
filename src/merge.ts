import { archiveIfAllMerged, isAlive } from "./preview.ts";
import { chunksOf, repoName, stackRefusal } from "./repos.ts";
import { listStates, lookupRepo, markRepoMerged, MERGED, readState, updateState, upsertChunk, type Chunk, type MergeRun, type Repo, type State } from "./state.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;
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
export const defaultRunner: Runner = async (cmd, args, { cwd, timeoutMs }) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    timeout: timeoutMs,
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
  | { kind: "blocked"; reason: string };

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
  if (v.mergeStateStatus === "BLOCKED") return { kind: "blocked", reason: `merge blocked by branch protection on #${n}` };
  return { kind: "ready" };
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Pipeline + repo with a merge job in this process.
const activeKey = (id: string, repo: string) => `${id}\n${repo}`;
const active = new Set<string>();
export const isMergeRunning = () => active.size > 0;

// The engine refreshes updatedAt at every poll, so a silent run is dead even if its pid was reused.
const STALE_MS = 5 * 60_000;
const isStale = (m: MergeRun | undefined, alive: (pid: number) => boolean) =>
  m?.status === "running" && (m.pid === undefined || !alive(m.pid) || Date.now() - Date.parse(m.updatedAt) > STALE_MS);

function runningMerge(repo: string, startedAt: string): MergeRun {
  return { status: "running", repo, pid: process.pid, message: "starting", startedAt, updatedAt: new Date().toISOString() };
}

// The repo to merge: optional with one repo, required with several.
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
  rawRepo?: unknown,
  rawDelete?: unknown,
): { state: State; done: Promise<void> } {
  let s: State;
  try {
    s = readState(id);
  } catch (err) {
    throw new MergeError(errorMessage(err), 404);
  }
  const repo = resolveMergeRepo(s, rawRepo);
  const key = activeKey(id, repo.path);
  const prev = s.merges?.[repo.path];
  if (active.has(key) || (prev?.status === "running" && !isStale(prev, isAlive))) {
    throw new MergeError("a merge is already running", 409);
  }
  const open = chunksOf(s, repo.path).filter((c) => c.pr && c.status !== MERGED).length;
  if (open === 0) throw new MergeError("no open PR to merge", 400);
  if (open >= 2) throw new MergeError(stackRefusal(repo.path, open), 409);
  if (rawDelete !== undefined && rawDelete !== null && typeof rawDelete !== "boolean") throw new MergeError("deleteBranches must be a boolean", 400);

  active.add(key);
  updateState(id, (x) => {
    (x.merges ??= {})[repo.path] = runningMerge(repo.path, new Date().toISOString());
  });
  const done = mergeStack(id, deps, repo.path, rawDelete === true).finally(() => active.delete(key));
  return { state: readState(id), done };
}

// A merge whose dashboard died stays "running" forever: mark it failed so the user can resume.
export function failStaleMerges(alive: (pid: number) => boolean = isAlive): void {
  for (const s of listStates()) {
    if (!Object.values(s.merges ?? {}).some((m) => isStale(m, alive))) continue;
    updateState(s.id, (x) => {
      const now = new Date().toISOString();
      for (const [repo, run] of Object.entries(x.merges ?? {})) {
        if (!isStale(run, alive)) continue;
        x.merges![repo] = { ...run, status: "failed", error: "interrupted: the dashboard stopped; click Merge to resume", updatedAt: now, endedAt: now };
      }
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
  mergePr: (c: Chunk, head: string, message: string) => Promise<void>;
  waitReady: (c: Chunk, first: PrView) => Promise<PrView>;
}

function makeCtx(id: string, repo: string, d: MergeDeps): Ctx {
  const iso = () => new Date().toISOString();
  // Short read-modify-write: the skill and the CLI write the same file while we wait. Runs of two repos
  // share it too: safe in-process, as updateState has no await and each run touches only its own key.
  const write = (fields: Partial<MergeRun>) =>
    updateState(id, (s) => {
      s.merges![repo] = { ...s.merges![repo]!, ...fields, updatedAt: iso() };
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

  const mergePr: Ctx["mergePr"] = async (c, head, message) => {
    const url = c.pr!;
    const { owner, repo: name, number: n } = parsePrUrl(url);
    // No -d: the branches go together, after the merge (see deleteBranches). No squash fallback: the chunk commits must stay.
    const r = await gh(["pr", "merge", url, "--merge", "--match-head-commit", head]);
    if (r.code !== 0 && /merge commits are not allowed/i.test(r.stderr)) {
      throw new Error(`merge commits are not allowed on ${owner}/${name}: enable "Allow merge commits" in the GitHub settings, or merge #${n} by hand`);
    }
    if (r.code !== 0) throw new Error(`gh pr merge #${n} failed: ${firstLine(r.stderr)}`);
    upsertChunk(id, { name: c.name, status: MERGED });
    progress(c, message);
  };

  // `first` is reused for the first poll, then the PR is read again.
  const waitReady: Ctx["waitReady"] = async (c, first) => {
    const url = c.pr!;
    const n = parsePrUrl(url).number;
    let v = first;
    const t0 = d.now();
    let checksSince: number | undefined;
    for (let reuse = true; ; reuse = false) {
      if (!reuse) v = await view(url);
      const verdict = classifyPr(v);
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

// Deletes the PR's remote branches, never the base. Returns the branches that could not go:
// a failure here must not undo a merge that already happened.
async function deleteBranches(x: Ctx, chunks: Chunk[], keep: string[]): Promise<string[]> {
  const names = [...new Set(chunks.filter((c) => c.pr).map((c) => c.branch).filter((b): b is string => !!b && !keep.includes(b)))];
  const left: string[] = [];
  for (const b of names) {
    const r = await x.d.run("git", ["push", "origin", "--delete", b], { cwd: x.repo });
    // A branch already gone (deleted by GitHub or by hand) is the goal reached.
    if (r.code !== 0 && !/remote ref does not exist/i.test(r.stderr)) left.push(b);
  }
  return left;
}

// Merge the repo's single open PR into its base with a merge commit. No rebase, push or retarget.
async function mergeIntoBase(x: Ctx, repo: Repo, chunks: Chunk[], remove: boolean): Promise<void> {
  const prs = chunks.filter((c) => c.pr);
  const open = prs.filter((c) => c.status !== MERGED);
  if (open.length >= 2) throw new Error(stackRefusal(repo.path, open.length));
  if (!open.length) throw new Error("no open PR to merge");
  const c = open[0]!;
  const n = parsePrUrl(c.pr!).number;
  x.progress(c, `checking #${n}`);
  const v = await x.view(c.pr!);
  if (v.state === "CLOSED") throw new Error(`PR #${n} is closed`);
  // GitHub is the truth: the state base only serves before a PR exists, so a stale one must not block.
  const base = v.baseRefName;
  if (v.state === "MERGED") upsertChunk(x.id, { name: c.name, status: MERGED });
  else {
    const ready = await x.waitReady(c, v);
    await x.mergePr(c, ready.headRefOid, `merged #${n}`);
  }
  // One PR per repo: the chunks without a PR are merged with it.
  updateState(x.id, (s) => void markRepoMerged(s, x.repo));
  const left = remove ? await deleteBranches(x, prs, [base, repo.base ?? base]) : [];
  x.finish(`merged #${n} into ${base}` + (left.length ? `; could not delete ${left.join(", ")}` : ""));
}

// Never throws: every failure ends up in state.merges. `repo` is a path or a name.
export async function mergeStack(
  id: string,
  deps: Partial<MergeDeps> = {},
  repoRef?: string,
  removeBranches = false,
): Promise<void> {
  const d: MergeDeps = {
    run: defaultRunner,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    limits: DEFAULT_LIMITS,
    ...deps,
  };
  let repo: Repo | undefined;
  try {
    const s = readState(id);
    repo = resolveMergeRepo(s, repoRef);
    const prev = s.merges?.[repo.path];
    const startedAt = prev?.status === "running" ? prev.startedAt : new Date().toISOString();
    const found = repo;
    updateState(id, (x) => {
      (x.merges ??= {})[found.path] = runningMerge(found.path, startedAt);
    });
    const x = makeCtx(id, found.path, d);
    await mergeIntoBase(x, found, chunksOf(readState(id), found.path), removeBranches);
    if (readState(id).merges?.[found.path]?.status === "done") await archiveIfAllMerged(id);
  } catch (err) {
    try {
      if (!repo) {
        // Direct call only (the route resolves the repo first): no key to write under.
        console.error(`merge ${id}: ${errorMessage(err)}`);
        return;
      }
      const key = repo.path;
      updateState(id, (s) => {
        const now = new Date().toISOString();
        const run = s.merges?.[key] ?? runningMerge(key, now);
        (s.merges ??= {})[key] = { ...run, status: "failed", error: errorMessage(err), endedAt: now, updatedAt: now };
      });
    } catch {
      // The state file is gone (pipeline deleted): nothing left to report to.
    }
  }
}
