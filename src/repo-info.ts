import { realpathSync } from "node:fs";
import { git } from "./preview.ts";

export type BaseFrom = "current" | "reflog" | "origin";
export interface RepoInfo {
  path: string; // the repo's main checkout; the input's toplevel when the main repo is bare
  base?: string;
  baseFrom?: BaseFrom; // set only when base is set
  worktree?: string; // input toplevel, only when it is a linked worktree on a branch that is not the base
  branch?: string; // that worktree's current branch
  dirty: boolean;
}

export const branchExists = (cwd: string, b: string) =>
  ["refs/heads/", "refs/remotes/origin/"].some((ref) => git(cwd, "show-ref", "--verify", "--quiet", ref + b).status === 0);

// The reflog's oldest entry names the branch a worktree branch was created from (a sha, tag or HEAD is no branch).
function createdFrom(cwd: string, branch: string): string | undefined {
  const lines = git(cwd, "reflog", "show", "--format=%gs", `refs/heads/${branch}`).stdout.split("\n").filter(Boolean);
  const m = lines.at(-1)?.match(/^branch: Created from (.+)$/);
  const src = m?.[1]?.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
  return src && src !== "HEAD" && branchExists(cwd, src) ? src : undefined;
}

const real = (p: string) => {
  try { return realpathSync(p); } catch { return p; }
};

// The repo is its main checkout, so a subfolder or a T3 worktree never makes a second repo, and the pipeline outlives the worktree.
export function repoInfo(input: string): RepoInfo {
  const topRes = git(input, "rev-parse", "--show-toplevel");
  if (topRes.status !== 0) throw new Error(`not a git repo: ${input}`);
  const top = topRes.stdout.trim();
  const current = git(top, "branch", "--show-current").stdout.trim();
  const gitDir = real(git(top, "rev-parse", "--absolute-git-dir").stdout.trim());
  const common = real(git(top, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim());
  const linked = gitDir !== common;
  let path = top;
  if (linked) {
    const first = git(top, "worktree", "list", "--porcelain").stdout.split("\n\n")[0]!.split("\n");
    const main = first.find((l) => l.startsWith("worktree "))?.slice(9);
    if (main && !first.includes("bare")) path = main;
  }
  const dflt = git(top, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim().replace(/^origin\//, "");
  const src = linked && current ? createdFrom(top, current) : undefined;
  const found: [string, BaseFrom] | undefined =
    (!linked || current === dflt || src === current) && current ? [current, "current"]
    : src ? [src, "reflog"]
    : dflt ? [dflt, "origin"]
    : undefined;
  const status = git(top, "status", "--porcelain");
  const base = found?.[0];
  return {
    path,
    ...(found && { base: found[0], baseFrom: found[1] }),
    ...(linked && current && current !== base && { worktree: top, branch: current }),
    dirty: status.status === 0 && status.stdout.trim() !== "",
  };
}
