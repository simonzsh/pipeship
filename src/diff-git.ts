import { existsSync } from "node:fs";
import { diffTotals, parseDiff, type DiffErrorCode, type DiffResponse } from "./diff.ts";
import { defaultRunner } from "./merge.ts";
import { diffRange, findRepo, repoName } from "./repos.ts";
import { readState, statePath } from "./state.ts";

export const DIFF_LIMITS = { maxBytes: 5_000_000, maxLinesPerFile: 3000, timeoutMs: 15_000 };

export class DiffError extends Error {
  constructor(message: string, readonly status: number, readonly code: DiffErrorCode) {
    super(message);
  }
}

const STATUS: Record<DiffErrorCode, number> = {
  not_found: 404, bad_request: 400, no_branch: 409, no_base: 409, missing_ref: 409, no_repo: 409, git_failed: 500,
};
const fail = (code: DiffErrorCode, message: string) => new DiffError(message, STATUS[code], code);

// Async on purpose: preview.ts git() is spawnSync and would block the SSE loop on big diffs.
async function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

// Full refs, so a tag with the same name cannot win in the diff range.
async function firstRef(cwd: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    if ((await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
  }
  return undefined;
}
const local = (b: string) => `refs/heads/${b}`;
const remote = (b: string) => `refs/remotes/origin/${b}`;

// Head: local first (it can hold unpushed work), then origin (local copy deleted).
export const headRef = (cwd: string, b: string) => firstRef(cwd, [local(b), remote(b)]);
// Base: origin first, as the base can move there while the local copy stays old.
export const baseRef = (cwd: string, b: string) => firstRef(cwd, [remote(b), local(b)]);

// Best effort: offline or a branch not on origin keeps the refs we have.
async function fetchBranch(cwd: string, branch: string): Promise<void> {
  const refspec = `+${local(branch)}:${remote(branch)}`;
  await defaultRunner("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", refspec], { cwd, timeoutMs: 10_000 }).catch(() => {});
}

// Local head against its origin copy: ahead = not pushed, behind = only on origin.
async function originSync(cwd: string, branch: string, head: string): Promise<{ ahead: number; behind: number } | null> {
  if (head !== local(branch)) return null;
  const { code, out } = await runGit(cwd, ["rev-list", "--left-right", "--count", `${remote(branch)}...${head}`]);
  if (code !== 0) return null;
  const [behind, ahead] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead!, behind: behind! };
}

const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

export async function gitDiff(
  cwd: string, from: string, to: string, limits = DIFF_LIMITS,
): Promise<{ text: string; truncated: boolean }> {
  const proc = Bun.spawn(
    [
      "git", "-C", cwd, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U3", `${from}...${to}`, "--",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, limits.timeoutMs);
  const stderr = new Response(proc.stderr).text();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      parts.push(chunk);
      size += chunk.length;
      if (size > limits.maxBytes) {
        truncated = true;
        proc.kill();
        break;
      }
    }
    const code = await proc.exited;
    if (timedOut) throw fail("git_failed", `git diff timed out after ${limits.timeoutMs} ms`);
    if (code !== 0 && !truncated) throw fail("git_failed", `git diff failed: ${(await stderr).trim() || `exit ${code}`}`);
  } finally {
    clearTimeout(timer);
  }
  let text = Buffer.concat(parts).subarray(0, limits.maxBytes).toString("utf8");
  if (truncated) {
    // Cut on a file boundary: a half file would show wrong counts.
    const i = text.lastIndexOf("\ndiff --git ");
    text = i < 0 ? "" : text.slice(0, i + 1);
  }
  return { text, truncated };
}

export async function pipelineDiff(
  id: string, repoRef: string | null, chunk: string | null, limits = DIFF_LIMITS,
): Promise<DiffResponse> {
  if (!existsSync(statePath(id))) throw fail("not_found", `unknown pipeline: ${id}`);
  const state = readState(id);
  const repo = repoRef ? findRepo(state, repoRef) : state.repos.length === 1 ? state.repos[0] : undefined;
  if (!repo) throw fail("bad_request", repoRef ? `unknown repo: ${repoRef}` : "repo is required");
  const name = repoName(repo.path);
  const range = diffRange(state, repo, chunk ?? undefined);
  if ("error" in range) throw fail(range.code, range.error);
  if (!existsSync(repo.path) || (await runGit(repo.path, ["rev-parse", "--git-dir"])).code !== 0) {
    throw fail("no_repo", `${repo.path} is not a git repository`);
  }
  await Promise.all([fetchBranch(repo.path, range.from), fetchBranch(repo.path, range.to)]);
  const refs = await Promise.all([baseRef(repo.path, range.from), headRef(repo.path, range.to)]);
  const missing = refs.findIndex((r) => !r);
  if (missing >= 0) throw fail("missing_ref", `branch "${[range.from, range.to][missing]}" not found in ${name}`);
  const [{ text, truncated }, origin] = await Promise.all([gitDiff(repo.path, refs[0]!, refs[1]!, limits), originSync(repo.path, range.to, refs[1]!)]);
  const files = parseDiff(text, { maxLinesPerFile: limits.maxLinesPerFile });
  const { additions, deletions } = diffTotals(files);
  return {
    repo: repo.path, name, chunk, from: range.from, to: range.to, range: refs.map((r) => shortRef(r!)).join("..."),
    files, additions, deletions, truncated, origin,
  };
}
