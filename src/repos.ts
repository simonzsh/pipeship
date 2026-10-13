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
  return chunksOf(state, repo).filter((c) => c.worktree).pop();
}

export function repoOf(state: Pick<State, "repos">, chunk: Pick<Chunk, "repo">): Repo | undefined {
  return state.repos.find((r) => r.path === chunk.repo);
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
