import { existsSync } from "node:fs";
import { diffTotals, parseDiff, type DiffErrorCode, type DiffResponse } from "./diff.ts";
import { diffRange, findRepo, repoName } from "./repos.ts";
import { readState } from "./state.ts";

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

// Local branch first, then the remote one (a branch can be pushed and its local copy deleted).
// Returns the full ref so a tag with the same name cannot win in the diff range.
export async function resolveRef(cwd: string, branch: string): Promise<string | undefined> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if ((await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
  }
  return undefined;
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
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  let text = new TextDecoder().decode(buf.subarray(0, Math.min(size, limits.maxBytes)));
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
  const state = readState(id);
  const repo = repoRef ? findRepo(state, repoRef) : state.repos.length === 1 ? state.repos[0] : undefined;
  if (!repo) throw fail("bad_request", repoRef ? `unknown repo: ${repoRef}` : "repo is required");
  const name = repoName(repo.path);
  const range = diffRange(state, repo, chunk ?? undefined);
  if ("error" in range) throw fail(range.code, range.error);
  if (!existsSync(repo.path) || (await runGit(repo.path, ["rev-parse", "--git-dir"])).code !== 0) {
    throw fail("no_repo", `${repo.path} is not a git repository`);
  }
  const refs: string[] = [];
  for (const branch of [range.from, range.to]) {
    const ref = await resolveRef(repo.path, branch);
    if (!ref) throw fail("missing_ref", `branch "${branch}" not found in ${name}`);
    refs.push(ref);
  }
  const { text, truncated } = await gitDiff(repo.path, refs[0]!, refs[1]!, limits);
  const files = parseDiff(text, { maxLinesPerFile: limits.maxLinesPerFile });
  const { additions, deletions } = diffTotals(files);
  return {
    repo: repo.path, name, chunk, from: range.from, to: range.to, range: refs.map(shortRef).join("..."),
    files, additions, deletions, truncated,
  };
}
