import type { State } from "../state.ts";
import { chunksOf } from "../repos.ts";

// chunk undefined = whole repo (one diff per repo with at least one branch).
export type DiffTarget = { chunk?: string };
export interface DiffRequest {
  repo: string;
  chunk?: string;
}

export function diffRequests(p: Pick<State, "repos" | "chunks">, target: DiffTarget): DiffRequest[] {
  if (target.chunk !== undefined) {
    const c = p.chunks.find((x) => x.name === target.chunk);
    return c ? [{ repo: c.repo, chunk: c.name }] : [];
  }
  return p.repos.filter((r) => chunksOf(p, r.path).some((c) => c.branch)).map((r) => ({ repo: r.path }));
}

export function diffUrl(id: string, req: DiffRequest, force = false): string {
  const q = new URLSearchParams({ repo: req.repo });
  if (req.chunk !== undefined) q.set("chunk", req.chunk);
  if (force) q.set("fetch", "1");
  return `/api/pipelines/${encodeURIComponent(id)}/diff?${q}`;
}
