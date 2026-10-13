import { existsSync } from "node:fs";
import { isAlive } from "./preview.ts";
import { listStates, MERGED, readState, updateState, upsertChunk, type Chunk, type MergeMode, type MergeRun, type State } from "./state.ts";

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

// Anything but an explicit "base" gets the safe default: combine never touches the base branch.
export const parseMergeMode = (body: unknown): MergeMode =>
  (body as { mode?: unknown } | null)?.mode === "base" ? "base" : "combine";

// Pipeline ids with a merge job in this process.
const active = new Set<string>();

// The engine refreshes updatedAt at every poll, so a silent run is dead even if its pid was reused.
const STALE_MS = 5 * 60_000;
const isStale = (m: MergeRun | undefined, alive: (pid: number) => boolean) =>
  m?.status === "running" && (m.pid === undefined || !alive(m.pid) || Date.now() - Date.parse(m.updatedAt) > STALE_MS);

export function startMerge(id: string, deps: Partial<MergeDeps> = {}, mode: MergeMode = "combine"): { state: State; done: Promise<void> } {
  let s: State;
  try {
    s = readState(id);
  } catch (err) {
    throw new MergeError(err instanceof Error ? err.message : String(err), 404);
  }
  if (active.has(id) || (s.merge?.status === "running" && !isStale(s.merge, isAlive))) {
    throw new MergeError("a merge is already running", 409);
  }
  const open = s.chunks.filter((c) => c.pr && c.status !== MERGED).length;
  if (open === 0) throw new MergeError("no open PR to merge", 400);
  if (mode === "combine" && open < 2) throw new MergeError("only one open PR: nothing to combine", 400);

  active.add(id);
  const now = new Date().toISOString();
  updateState(id, (x) => {
    x.merge = { status: "running", mode, pid: process.pid, message: "starting", startedAt: now, updatedAt: now, oldTips: s.merge?.oldTips };
  });
  const done = mergeStack(id, deps, mode).finally(() => active.delete(id));
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

// Never throws: every failure ends up in state.merge.
export async function mergeStack(id: string, deps: Partial<MergeDeps> = {}, mode: MergeMode = "combine"): Promise<void> {
  const d: MergeDeps = {
    run: defaultRunner,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    limits: DEFAULT_LIMITS,
    ...deps,
  };
  const iso = () => new Date().toISOString();
  // Short read-modify-write: the skill and the CLI write the same file while we wait.
  const write = (fields: Partial<MergeRun>) =>
    updateState(id, (s) => {
      s.merge = { ...s.merge!, ...fields, updatedAt: iso() };
    });
  const progress = (c: Chunk, pr: number, message: string) => write({ current: c.name, pr, message });

  try {
    const s = readState(id);
    const startedAt = s.merge?.status === "running" ? s.merge.startedAt : iso();
    updateState(id, (x) => {
      x.merge = { status: "running", mode, pid: process.pid, message: "starting", startedAt, updatedAt: iso(), oldTips: x.merge?.oldTips };
    });

    const gh = async (args: string[]) => d.run("gh", args, { cwd: s.repo });
    const view = async (url: string): Promise<PrView> => {
      const fields = "number,url,state,baseRefName,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
      const r = await gh(["pr", "view", url, "--json", fields]);
      if (r.code !== 0) throw new Error(`gh pr view failed: ${firstLine(r.stderr)}`);
      return JSON.parse(r.stdout) as PrView;
    };

    // Just after a push, CI has not queued yet: "no checks" and "blocked" are not final answers.
    const waitReady = async (c: Chunk, url: string, n: number, first: PrView, pushed: boolean, expectedHead: string): Promise<PrView> => {
      let v = first;
      const hadChecks = v.statusCheckRollup.length > 0;
      const t0 = d.now();
      let checksSince: number | undefined;
      for (;;) {
        v = await view(url);
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
        progress(c, n, verdict.reason);
        await d.sleep(d.limits.pollMs);
      }
      return v;
    };

    // Combine: fold each PR into the branch of the PR below, top first. No rebase, retarget or push:
    // origin and the base branch stay untouched, and the bottom PR collects the whole stack.
    const combine = async (chunks: Chunk[]) => {
      const views = await Promise.all(chunks.map((c) => view(c.pr!)));
      const closed = views.find((v) => v.state === "CLOSED");
      if (closed) throw new Error(`PR #${closed.number} is closed`);
      chunks.forEach((c, i) => views[i]!.state === "MERGED" && upsertChunk(id, { name: c.name, status: MERGED }));
      const open = chunks.map((c, i) => ({ c, v: views[i]! })).filter((x) => x.v.state === "OPEN");
      const bottom = open[0];
      if (!bottom) throw new Error("no open PR to combine");
      const bottomIdx = chunks.indexOf(bottom.c);

      for (let i = open.length - 1; i >= 1; i--) {
        const { c } = open[i]!;
        const below = open[i - 1]!.v;
        const url = c.pr!;
        const n = parsePrUrl(url).number;
        progress(c, n, `checking #${n}`);
        let v = await view(url);
        if (v.baseRefName !== below.headRefName) throw new Error(`PR #${n} targets ${v.baseRefName}, not ${below.headRefName}`);
        v = await waitReady(c, url, n, v, false, v.headRefOid);

        // No -d: the remote branches stay.
        const args = (kind: string) => ["pr", "merge", url, kind, "--match-head-commit", v.headRefOid];
        let merge = await gh(args("--merge"));
        // Squash is the fallback only when the repo refuses merge commits, not for any other failure.
        if (merge.code !== 0 && /merge commits are not allowed|not allowed to merge/i.test(merge.stderr)) {
          merge = await gh(args("--squash"));
        }
        if (merge.code !== 0) throw new Error(`gh pr merge #${n} failed: ${firstLine(merge.stderr)}`);
        upsertChunk(id, { name: c.name, status: MERGED });
        progress(c, n, `combined #${n} into ${below.headRefName}`);
      }

      // Every PR above the bottom one is merged now, including those from an earlier run.
      const folded = chunks.slice(bottomIdx + 1).map((c) => c.pr!);
      const bottomUrl = bottom.c.pr!;
      const bn = parsePrUrl(bottomUrl);
      if (folded.length) {
        progress(bottom.c, bn.number, `updating the description of #${bn.number}`);
        const fail = (why: string) => new Error(`could not update the description of #${bn.number}: ${why}`);
        const got = await gh(["pr", "view", bottomUrl, "--json", "body"]);
        if (got.code !== 0) throw fail(firstLine(got.stderr));
        const body: string = (JSON.parse(got.stdout) as { body?: string }).body ?? "";
        const todo = folded.filter((u) => !body.includes(u));
        if (todo.length) {
          const line = `Combines ${todo.map((u) => `#${parsePrUrl(u).number}`).join(", ")} (merged into this branch):\n${todo.map((u) => `- ${u}`).join("\n")}`;
          const patch = await gh(["api", "-X", "PATCH", `repos/${bn.owner}/${bn.repo}/pulls/${bn.number}`, "-f", `body=${body.trimEnd()}\n\n${line}\n`]);
          if (patch.code !== 0) throw fail(firstLine(patch.stderr));
        }
      }
      const total = folded.length + 1;
      write({ status: "done", current: undefined, pr: undefined, oldTips: undefined, message: `combined ${total} PRs into #${bn.number}`, endedAt: iso() });
    };

    const chunks = s.chunks.filter((c) => c.pr);
    if (mode === "combine") {
      await combine(chunks);
      return;
    }
    let base = s.base;
    if (!base) base = (await view(chunks[0]!.pr!)).baseRefName;
    // The PR below, once merged. GitHub reports its rebased head, but the next branch still sits on
    // the head it had before the rebase, so the next rebase needs that old tip (kept in state.merge.oldTips).
    let prev: { headRefName: string; oldTip: string } | undefined;
    const tipOf = (c: Chunk, v: PrView) => readState(id).merge?.oldTips?.[c.name] ?? v.headRefOid;
    let count = 0;

    for (const c of chunks) {
      const url = c.pr!;
      const { owner, repo, number: n } = parsePrUrl(url);
      progress(c, n, `checking #${n}`);
      let v = await view(url);

      if (v.state === "MERGED") {
        upsertChunk(id, { name: c.name, status: MERGED });
        prev = { headRefName: v.headRefName, oldTip: tipOf(c, v) };
        continue;
      }
      if (v.state === "CLOSED") throw new Error(`PR #${n} is closed`);

      let expectedHead = v.headRefOid;
      let pushed = false;
      if (v.baseRefName !== base) {
        if (!prev || prev.headRefName !== v.baseRefName) {
          throw new Error(`PR #${n} targets ${v.baseRefName}, not ${base}, and the PR below is not merged`);
        }
        const wt = c.worktree;
        if (!wt || !existsSync(wt)) {
          throw new Error(`worktree of ${c.name} is missing (${wt}): rebase PR #${n} by hand or recreate it`);
        }
        const branch = v.headRefName;
        const git = (...args: string[]) => d.run("git", args, { cwd: wt });
        const dirty = await git("status", "--porcelain");
        if (dirty.stdout.trim() !== "") throw new Error(`uncommitted changes in ${wt}`);
        const head = await git("rev-parse", "--abbrev-ref", "HEAD");
        if (head.stdout.trim() !== branch) throw new Error(`${wt} is not on ${branch}`);

        const fetched = await git("fetch", "origin");
        if (fetched.code !== 0) throw new Error(`git fetch failed: ${firstLine(fetched.stderr)}`);
        // The force push would delete any commit that GitHub has and the worktree lacks.
        if ((await git("rev-parse", "HEAD")).stdout.trim() !== v.headRefOid) {
          throw new Error(`${branch} on GitHub has commits that are not in ${wt}: pull them first`);
        }
        // After an interrupted run the branch is already rebased: only the retarget is left.
        const rebased = (await git("merge-base", "--is-ancestor", `origin/${base}`, "HEAD")).code === 0;
        if (!rebased) {
          progress(c, n, `rebasing ${branch} onto ${base}`);
          updateState(id, (x) => {
            x.merge!.oldTips = { ...x.merge!.oldTips, [c.name]: v.headRefOid };
          });
          const rebase = await git("rebase", "--onto", `origin/${base}`, prev.oldTip, branch);
          if (rebase.code !== 0) {
            await git("rebase", "--abort");
            const conflict = (rebase.stdout + rebase.stderr).split("\n").find((l) => l.includes("CONFLICT")) ?? firstLine(rebase.stderr);
            throw new Error(`rebase of ${branch} onto ${base} conflicts: ${conflict}`);
          }
          // Explicit lease: the fetch above moved the remote-tracking ref.
          const push = await git("push", `--force-with-lease=${branch}:${v.headRefOid}`, "origin", branch);
          if (push.code !== 0) throw new Error(`git push failed: ${firstLine(push.stderr)}`);
          expectedHead = (await git("rev-parse", "HEAD")).stdout.trim();
          pushed = true;
        }
        // `gh pr edit` fails on this setup, so retarget through the API.
        const patch = await gh(["api", "-X", "PATCH", `repos/${owner}/${repo}/pulls/${n}`, "-f", `base=${base}`]);
        if (patch.code !== 0) throw new Error(`retarget of #${n} failed: ${firstLine(patch.stderr)}`);
        progress(c, n, `${pushed ? `rebased ${branch} and ` : ""}retargeted #${n} to ${base}`);
      }

      v = await waitReady(c, url, n, v, pushed, expectedHead);

      // No -d: the remote branches stay.
      const merge = await gh(["pr", "merge", url, "--squash", "--match-head-commit", expectedHead]);
      if (merge.code !== 0) throw new Error(`gh pr merge #${n} failed: ${firstLine(merge.stderr)}`);
      count++;
      upsertChunk(id, { name: c.name, status: MERGED });
      progress(c, n, `merged #${n}`);
      prev = { headRefName: v.headRefName, oldTip: tipOf(c, v) };
    }

    write({ status: "done", current: undefined, pr: undefined, oldTips: undefined, message: `merged ${count} PR${count === 1 ? "" : "s"}`, endedAt: iso() });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      write({ status: "failed", error, endedAt: iso() });
    } catch {
      // The state file is gone (pipeline deleted): nothing left to report to.
    }
  }
}
