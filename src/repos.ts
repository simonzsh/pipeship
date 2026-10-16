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

export function mergeOf(state: Pick<State, "merges">, repo: string): MergeRun | undefined {
  return state.merges?.[repo];
}

// That repo's run is running, or any run when no repo is given.
export function mergeRunning(s: Pick<State, "merges">, repo?: string): boolean {
  if (repo !== undefined) return s.merges?.[repo]?.status === "running";
  return Object.values(s.merges ?? {}).some((m) => m.status === "running");
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
export function repoStacks(state: Pick<State, "repos" | "chunks" | "merges">): RepoStack[] {
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

// chunk undefined = whole repo: <repo base>...<last branched chunk>.
// chunk = name: <previous branched chunk's branch, else the repo base>...<chunk.branch>.
export function diffRange(state: Pick<State, "repos" | "chunks">, repo: Repo, chunk?: string): DiffRange {
  const chunks = chunksOf(state, repo.path);
  const name = repoName(repo.path);
  let target: Chunk | undefined;
  if (chunk === undefined) {
    target = chunks.findLast((c) => c.branch);
    if (!target) return { error: `no chunk of ${name} has a branch yet`, code: "no_branch" };
  } else {
    target = chunks.find((c) => c.name === chunk);
    if (!target) return { error: `unknown chunk: ${chunk}`, code: "not_found" };
    if (!target.branch) return { error: `chunk ${chunk} has no branch yet`, code: "no_branch" };
  }
  const before = chunk === undefined ? undefined : chunks.slice(0, chunks.indexOf(target)).findLast((c) => c.branch);
  const from = before?.branch ?? repo.base;
  if (!from) return { error: `${name} has no base branch`, code: "no_base" };
  return { from, to: target.branch! };
}

// A stack of PRs from an older pipeship is not merged here.
export const stackRefusal = (repo: string, open: number) =>
  `${open} PRs of ${repoName(repo)} are not merged: pipeship merges one PR per repo. Merge this stack on GitHub, or with an older pipeship that combines stacks.`;

// The PRs still to merge. A closed PR counts: the merge refuses it rather than skip it.
// "merged" is spelled out: importing MERGED from state.ts would pull node: into the browser.
export const openPrChunks = (chunks: Chunk[]): Chunk[] => chunks.filter((c) => c.pr && c.status !== "merged");

export interface PrGroup {
  head?: Chunk; // the chunk that carries the PR; none for chunks not in a PR yet
  chunks: Chunk[];
}

// A chunk belongs to the PR of the first chunk at or after it that has one: the PR holds the branches below it.
// Chunks after the last PR have no PR yet.
export function groupByPr(chunks: Chunk[]): PrGroup[] {
  const groups: PrGroup[] = [];
  let pending: Chunk[] = [];
  for (const c of chunks) {
    pending.push(c);
    if (c.pr) {
      groups.push({ head: c, chunks: pending });
      pending = [];
    }
  }
  if (pending.length) groups.push({ chunks: pending });
  return groups;
}
