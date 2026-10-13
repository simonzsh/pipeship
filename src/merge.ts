import { existsSync } from "node:fs";
import { isAlive } from "./preview.ts";
import { listStates, MERGED, readState, updateState, upsertChunk, type Chunk, type State } from "./state.ts";

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

// Async on purpose: a sync spawn would freeze the dashboard's SSE stream during a rebase or push.
export const defaultRunner: Runner = async (cmd, args, { cwd }) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
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
    : c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "");
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

// Pipeline ids with a merge job in this process.
const active = new Set<string>();

export function startMerge(id: string, deps: Partial<MergeDeps> = {}): { state: State; done: Promise<void> } {
  let s: State;
  try {
    s = readState(id);
  } catch (err) {
    throw new MergeError(err instanceof Error ? err.message : String(err), 404);
  }
  const running = s.merge?.status === "running";
  if (active.has(id) || (running && s.merge!.pid !== undefined && isAlive(s.merge!.pid))) {
    throw new MergeError("a merge is already running", 409);
  }
  if (!s.chunks.some((c) => c.pr && c.status !== MERGED)) throw new MergeError("no open PR to merge", 400);

  active.add(id);
  const now = new Date().toISOString();
  updateState(id, (x) => {
    x.merge = { status: "running", pid: process.pid, message: "starting", startedAt: now, updatedAt: now };
  });
  const done = mergeStack(id, deps).finally(() => active.delete(id));
  return { state: readState(id), done };
}

// A merge whose dashboard died stays "running" forever: mark it failed so the user can resume.
export function failStaleMerges(alive: (pid: number) => boolean = isAlive): void {
  for (const s of listStates()) {
    const m = s.merge;
    if (m?.status !== "running" || (m.pid !== undefined && alive(m.pid))) continue;
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

// Never throws: every failure ends up in state.merge.
export async function mergeStack(id: string, deps: Partial<MergeDeps> = {}): Promise<void> {
  const d: MergeDeps = {
    run: defaultRunner,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    limits: DEFAULT_LIMITS,
    ...deps,
  };
  const iso = () => new Date().toISOString();
  // Short read-modify-write: the skill and the CLI write the same file while we wait.
  const write = (fields: Partial<NonNullable<State["merge"]>>) =>
    updateState(id, (s) => {
      s.merge = { ...s.merge!, ...fields, updatedAt: iso() };
    });
  const progress = (c: Chunk, pr: number, message: string) => write({ current: c.name, pr, message });

  try {
    const s = readState(id);
    const startedAt = s.merge?.status === "running" ? s.merge.startedAt : iso();
    updateState(id, (x) => {
      x.merge = { status: "running", pid: process.pid, message: "starting", startedAt, updatedAt: iso() };
    });

    const gh = async (args: string[]) => d.run("gh", args, { cwd: s.repo });
    const view = async (url: string): Promise<PrView> => {
      const fields = "number,url,state,baseRefName,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
      const r = await gh(["pr", "view", url, "--json", fields]);
      if (r.code !== 0) throw new Error(`gh pr view failed: ${firstLine(r.stderr)}`);
      return JSON.parse(r.stdout) as PrView;
    };

    const chunks = s.chunks.filter((c) => c.pr);
    let base = s.base;
    if (!base) base = (await view(chunks[0]!.pr!)).baseRefName;
    let prev: PrView | undefined;
    let count = 0;

    for (const c of chunks) {
      const url = c.pr!;
      const { owner, repo, number: n } = parsePrUrl(url);
      progress(c, n, `checking #${n}`);
      let v = await view(url);

      if (v.state === "MERGED") {
        upsertChunk(id, { name: c.name, status: MERGED });
        prev = v;
        continue;
      }
      if (v.state === "CLOSED") throw new Error(`PR #${n} is closed`);

      let expectedHead = v.headRefOid;
      if (v.baseRefName !== base) {
        if (!prev || prev.state !== "MERGED" || prev.headRefName !== v.baseRefName) {
          throw new Error(`PR #${n} targets ${v.baseRefName}, not ${base}, and the PR below is not merged`);
        }
        const wt = c.worktree;
        if (!wt || !existsSync(wt)) {
          throw new Error(`worktree of ${c.name} is missing (${wt}): rebase PR #${n} by hand or recreate it`);
        }
        const git = (...args: string[]) => d.run("git", args, { cwd: wt });
        const dirty = await git("status", "--porcelain");
        if (dirty.stdout.trim() !== "") throw new Error(`uncommitted changes in ${wt}`);
        const head = await git("rev-parse", "--abbrev-ref", "HEAD");
        if (head.stdout.trim() !== v.headRefName) throw new Error(`${wt} is not on ${v.headRefName}`);

        progress(c, n, `rebasing ${v.headRefName} onto ${base}`);
        const fetch = await git("fetch", "origin");
        if (fetch.code !== 0) throw new Error(`git fetch failed: ${firstLine(fetch.stderr)}`);
        const rebase = await git("rebase", "--onto", `origin/${base}`, prev.headRefOid, v.headRefName);
        if (rebase.code !== 0) {
          await git("rebase", "--abort");
          const conflict = (rebase.stdout + rebase.stderr).split("\n").find((l) => l.includes("CONFLICT")) ?? firstLine(rebase.stderr);
          throw new Error(`rebase of ${v.headRefName} onto ${base} conflicts: ${conflict}`);
        }
        // Explicit lease: the fetch above moved the remote-tracking ref.
        const push = await git("push", `--force-with-lease=${v.headRefName}:${v.headRefOid}`, "origin", v.headRefName);
        if (push.code !== 0) throw new Error(`git push failed: ${firstLine(push.stderr)}`);
        expectedHead = (await git("rev-parse", "HEAD")).stdout.trim();
        // `gh pr edit` fails on this setup, so retarget through the API.
        const patch = await gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/pulls/${n}`, "-f", `base=${base}`]);
        if (patch.code !== 0) throw new Error(`retarget of #${n} failed: ${firstLine(patch.stderr)}`);
        progress(c, n, `rebased ${v.headRefName} and retargeted #${n} to ${base}`);
      }

      const t0 = d.now();
      let checksSince: number | undefined;
      for (;;) {
        v = await view(url);
        const verdict = classifyPr(v);
        if (verdict.kind === "ready") break;
        if (verdict.kind === "blocked") throw new Error(verdict.reason);
        if (verdict.pendingChecks) {
          checksSince ??= d.now();
          if (d.now() - checksSince > d.limits.checksMs) throw new Error(`checks still running on #${n} after 15 min`);
        } else if (d.now() - t0 > d.limits.mergeableMs) {
          throw new Error(`GitHub has not computed whether #${n} can merge after 2 min`);
        }
        progress(c, n, verdict.reason);
        await d.sleep(d.limits.pollMs);
      }

      // No -d: the remote branches stay.
      const merge = await gh(["pr", "merge", url, "--squash", "--match-head-commit", expectedHead]);
      if (merge.code !== 0) throw new Error(`gh pr merge #${n} failed: ${firstLine(merge.stderr)}`);
      count++;
      upsertChunk(id, { name: c.name, status: MERGED });
      progress(c, n, `merged #${n}`);
      prev = { ...v, state: "MERGED", headRefOid: expectedHead };
    }

    write({ status: "done", current: undefined, pr: undefined, message: `merged ${count} PRs`, endedAt: iso() });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      write({ status: "failed", error, endedAt: iso() });
    } catch {
      // The state file is gone (pipeline deleted): nothing left to report to.
    }
  }
}
