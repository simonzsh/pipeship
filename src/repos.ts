import type { Chunk, MergeRun, Repo, State } from "./state.ts";

// Pure helpers, no node: imports: the browser dashboard imports this file too.

// "/home/me/shop-api/" -> "shop-api"
export function repoName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

// Exact match on path or name; lookupRepo in state.ts resolves relative paths.
export function findRepo(state: Pick<State, "repos">, ref: string): Repo | undefined {
  return state.repos.find((r) => r.path === ref) ?? state.repos.find((r) => repoName(r.path) === ref);
}

export function assertRepoName(repos: Repo[], path: string): void {
  const clash = repos.find((r) => r.path !== path && repoName(r.path) === repoName(path));
  if (clash) throw new Error(`repo name "${repoName(path)}" is already used by ${clash.path}`);
}

export function chunksOf(state: Pick<State, "chunks">, repo: string): Chunk[] {
  return state.chunks.filter((c) => c.repo === repo);
}

export function topChunk(state: Pick<State, "chunks">, repo: string): Chunk | undefined {
  return chunksOf(state, repo).findLast((c) => c.worktree);
}

export function mergeOf(state: Pick<State, "merge">, repo: string): MergeRun | undefined {
  return state.merge?.repo === repo ? state.merge : undefined;
}

export function sharesRepo(a: Pick<State, "repos">, b: Pick<State, "repos">): boolean {
  return a.repos.some((r) => b.repos.some((o) => o.path === r.path));
}

export interface RepoStack {
  repo: Repo;
  name: string;
  chunks: Chunk[];
  merge?: MergeRun;
}

// Chunks of an unknown repo are left out.
export function repoStacks(state: Pick<State, "repos" | "chunks" | "merge">): RepoStack[] {
  return state.repos.map((repo) => ({
    repo,
    name: repoName(repo.path),
    chunks: chunksOf(state, repo.path),
    merge: mergeOf(state, repo.path),
  }));
}

export type DiffRange =
  | { from: string; to: string }
  | { error: string; code: "not_found" | "no_branch" | "no_base" };

// chunk undefined = whole stack: base...<last chunk with a branch>.
// chunk = name: <nearest previous chunk of the same repo with a branch | repo.base>...<chunk.branch>.
export function diffRange(state: Pick<State, "repos" | "chunks">, repo: Repo, chunk?: string): DiffRange {
  const chunks = chunksOf(state, repo.path);
  const name = repoName(repo.path);
  let target: Chunk | undefined;
  let before: Chunk[];
  if (chunk === undefined) {
    target = chunks.findLast((c) => c.branch);
    if (!target) return { error: `no chunk of ${name} has a branch yet`, code: "no_branch" };
    before = [];
  } else {
    const i = chunks.findIndex((c) => c.name === chunk);
    if (i < 0) return { error: `unknown chunk: ${chunk}`, code: "not_found" };
    target = chunks[i]!;
    if (!target.branch) return { error: `chunk ${chunk} has no branch yet`, code: "no_branch" };
    before = chunks.slice(0, i);
  }
  const prev = before.findLast((c) => c.branch);
  const from = prev?.branch ?? repo.base;
  if (!from) return { error: `${name} has no base branch`, code: "no_base" };
  return { from, to: target.branch! };
}
