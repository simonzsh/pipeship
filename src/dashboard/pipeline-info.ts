import type { State } from "../state.ts";
import type { DotStatus } from "./steps";

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// A running step of a pipeline that waits for the user shows as "waiting".
export function displaySteps(p: Pick<State, "steps" | "status">): { name: string; status: DotStatus }[] {
  return p.steps.map((s) => ({
    name: s.name,
    status: s.status === "running" && p.status === "waiting_for_user" ? ("waiting" as const) : s.status,
  }));
}

export function allMerged(p: Pick<State, "chunks">): boolean {
  const prChunks = p.chunks.filter((c) => c.pr);
  return prChunks.length > 0 && prChunks.every((c) => c.status === "merged");
}

export function finished(p: Pick<State, "status">): boolean {
  return p.status === "ready" || p.status === "failed" || p.status === "stopped";
}
