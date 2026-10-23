import type { State } from "../state.ts";
import type { DisplayStep } from "./steps";
import { repoName } from "../repos.ts";

// Age as a value and unit; null under a minute.
function age(iso: string, now: number): [number, "m" | "h" | "d"] | null {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return null;
  if (seconds < 3600) return [Math.floor(seconds / 60), "m"];
  if (seconds < 86400) return [Math.floor(seconds / 3600), "h"];
  return [Math.floor(seconds / 86400), "d"];
}

export function timeAgo(iso: string, now = Date.now()): string {
  const a = age(iso, now);
  return a ? `${a[0]} ${a[1] === "m" ? "min" : a[1]} ago` : "just now";
}

// Compact age for list cards: "now", "2m", "3h", "4d".
export function timeAgoShort(iso: string, now = Date.now()): string {
  const a = age(iso, now);
  return a ? `${a[0]}${a[1]}` : "now";
}

// "4m32" under an hour, "1h04" above.
export function formatElapsed(startedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}h${pad(Math.floor((seconds % 3600) / 60))}`;
}

// Only the step that waits shows as "waiting": another step may run meanwhile (preview while review waits).
export function displaySteps(p: Pick<State, "steps" | "status" | "waiting">): DisplayStep[] {
  return p.steps.map((s) => {
    const waiting = s.status === "running" && p.status === "waiting_for_user" && p.waiting?.step === s.name;
    return {
      name: s.name,
      status: waiting ? ("waiting" as const) : s.status,
      startedAt: s.startedAt,
      duration: s.startedAt && s.endedAt ? formatElapsed(s.startedAt, Date.parse(s.endedAt)) : undefined,
      note: waiting ? p.waiting?.reason : undefined,
    };
  });
}

export { allMerged } from "../repos.ts";

export function finished(p: Pick<State, "status">): boolean {
  return p.status === "ready" || p.status === "done" || p.status === "failed" || p.status === "stopped" || p.status === "archived";
}

// Sidebar search: every word of the query must match the title, a ticket ref, the id or a repo name.
export function matchesSearch(p: Pick<State, "id" | "ticket" | "repos">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [p.ticket.title, p.id, ...p.ticket.links.map((l) => l.ref), ...p.repos.map((r) => repoName(r.path))]
    .join("\n")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
