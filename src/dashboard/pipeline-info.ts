import type { State } from "../state.ts";
import type { DisplayStep } from "./steps";

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// "4m32" under an hour, "1h04" above.
export function formatElapsed(startedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}h${pad(Math.floor((seconds % 3600) / 60))}`;
}

// A running step of a pipeline that waits for the user shows as "waiting" and carries the question.
export function displaySteps(p: Pick<State, "steps" | "status"> & Partial<Pick<State, "waitingFor">>): DisplayStep[] {
  return p.steps.map((s) => {
    const waiting = s.status === "running" && p.status === "waiting_for_user";
    return {
      name: s.name,
      status: waiting ? ("waiting" as const) : s.status,
      startedAt: s.startedAt,
      duration: s.startedAt && s.endedAt ? formatElapsed(s.startedAt, Date.parse(s.endedAt)) : undefined,
      note: waiting ? p.waitingFor : undefined,
    };
  });
}

export function allMerged(p: Pick<State, "chunks">): boolean {
  const prChunks = p.chunks.filter((c) => c.pr);
  return prChunks.length > 0 && prChunks.every((c) => c.status === "merged");
}

export function finished(p: Pick<State, "status">): boolean {
  return p.status === "ready" || p.status === "done" || p.status === "failed" || p.status === "archived";
}
