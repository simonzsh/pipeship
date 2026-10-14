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

type Parent = Chunk | string | undefined; // a chunk of the stack, or a branch outside it

// Each chunk's parent: the chunk whose branch is its base, else the base branch itself.
// Base: the PR's base on GitHub, else the previous branched chunk, else the repo base.
// A cycle of retargeted PRs is cut at the repo base.
function stackParents(chunks: Chunk[], repo: Repo): Map<Chunk, Parent> {
  const byBranch = new Map(chunks.flatMap((c) => (c.branch ? [[c.branch, c] as const] : [])));
  const parents = new Map<Chunk, Parent>();
  let prev = repo.base;
  for (const c of chunks) {
    const base = c.prBase ?? prev;
    const parent = base === undefined ? undefined : byBranch.get(base);
    parents.set(c, parent && parent !== c ? parent : base);
    if (c.branch) prev = c.branch;
  }
  for (const c of chunks) {
    const seen = new Set<Chunk>();
    for (let p = parents.get(c); typeof p === "object" && !seen.has(p); p = parents.get(p)) {
      if (p === c) {
        parents.set(c, repo.base);
        break;
      }
      seen.add(p);
    }
  }
  return parents;
}

export type StackRow = { kind: "root"; branch: string } | { kind: "chunk"; chunk: Chunk; depth: number; rise: number };

// Tree rows for the stack panel, siblings in state order. rise = rows from the parent's row down to this one.
// Roots: the repo base first, then any other branch a PR targets outside the stack.
export function stackRows(chunks: Chunk[], repo: Repo): StackRow[] {
  const parents = stackParents(chunks, repo);
  const children = new Map<Parent, Chunk[]>();
  for (const c of chunks) children.set(parents.get(c), [...(children.get(parents.get(c)) ?? []), c]);
  const rows: StackRow[] = [];
  const place = (parent: Parent, depth: number) => {
    const at = rows.length - 1;
    for (const c of children.get(parent) ?? []) {
      rows.push({ kind: "chunk", chunk: c, depth, rise: rows.length - at });
      place(c, depth + 1);
    }
  };
  const roots = [...children.keys()].filter((p) => typeof p !== "object");
  roots.sort((a, b) => Number(b === repo.base) - Number(a === repo.base));
  for (const root of roots) {
    if (root !== undefined) rows.push({ kind: "root", branch: root });
    place(root, root === undefined ? 0 : 1);
  }
  return rows;
}

export type DiffRange =
  | { from: string; to: string }
  | { error: string; code: "not_found" | "no_branch" | "no_base" };

// chunk undefined = whole stack: <root of the last branched chunk>...<its branch>.
// chunk = name: <its parent's branch>...<chunk.branch>.
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
  const parents = stackParents(chunks, repo);
  let p = parents.get(target);
  if (chunk === undefined) while (typeof p === "object") p = parents.get(p);
  const from = typeof p === "object" ? p.branch : p;
  if (!from) return { error: `${name} has no base branch`, code: "no_base" };
  return { from, to: target.branch! };
}
