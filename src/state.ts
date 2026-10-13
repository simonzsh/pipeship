import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STEPS = ["map", "questions", "plan", "implement", "review", "stack", "preview"] as const;
export type StepName = (typeof STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type Status = "running" | "waiting_for_user" | "ready" | "failed" | "stopped";
export type Mode = "full" | "quick";

export interface Chunk {
  name: string;
  worktree?: string;
  branch?: string;
  status?: string;
  pr?: string;
}

export interface TicketLink {
  ref: string;
  url?: string;
}

export type Harness = "claude" | "codex";

// The agent session that runs the pipeline, recorded by `pipeship new`. No pid: it changes for the same Claude session.
export interface Session {
  harness: Harness;
  id: string;
  cwd: string;
}

// Computed by the dashboard server on read, never written to state.json.
export type SessionStatus = "active" | "loaded" | "stopped" | "archived" | "deleted" | "unknown";
export interface SessionState {
  status: SessionStatus;
  activity?: "busy" | "idle"; // Claude only, from the session registry
}

export type PipelineView = State & { sessionState?: SessionState };

export interface State {
  id: string;
  // One pipeline can cover several tickets of the same source.
  ticket: { source: string; title: string; links: TicketLink[] };
  repo: string;
  mode: Mode;
  status: Status;
  step: StepName;
  steps: { name: StepName; status: StepStatus; startedAt?: string; endedAt?: string }[];
  chunks: Chunk[];
  preview?: { url: string; port: number; pid: number; worktree: string; log: string; services?: PreviewService[] };
  session?: Session;
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewService {
  name: string;
  kind: string;
  port: number;
  url: string; // http://localhost:<port>
  pid: number;
  log: string; // <pipelineDir>/preview-<name>.log
}

// Quick mode: a single chunk, so no separate plan/contracts step.
const QUICK_SKIPS: StepName[] = ["plan"];

export function home(): string {
  return process.env.PIPESHIP_HOME ?? join(homedir(), ".pipeship");
}

export function pipelineDir(id: string): string {
  return join(home(), "pipelines", id);
}

function statePath(id: string): string {
  return join(pipelineDir(id), "state.json");
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ticket";
}

export function createPipeline(opts: {
  repo: string;
  title: string;
  name?: string;
  source: string;
  links?: TicketLink[];
  mode?: Mode;
  skip?: StepName[];
  session?: Session;
}): State {
  const now = new Date().toISOString();
  const links = opts.links ?? [];
  // No date in the id and no length cut: refs and names stay whole, the title gives its first 3 words.
  const base = slug(links.map((l) => l.ref).join("-") || opts.name || slug(opts.title).split("-").slice(0, 3).join("-"));
  let id = base;
  for (let n = 2; existsSync(pipelineDir(id)); n++) id = `${base}-${n}`;

  const mode = opts.mode ?? "full";
  const skipped = new Set([...(mode === "quick" ? QUICK_SKIPS : []), ...(opts.skip ?? [])]);
  const state: State = {
    id,
    ticket: { source: opts.source, title: opts.title, links },
    repo: opts.repo,
    mode,
    status: "running",
    step: STEPS[0],
    steps: STEPS.map((name) => ({ name, status: skipped.has(name) ? "skipped" : "pending" })),
    chunks: [],
    ...(opts.session && { session: opts.session }),
    stopRequested: false,
    createdAt: now,
    updatedAt: now,
  };
  mkdirSync(pipelineDir(id), { recursive: true });
  writeState(state);
  return state;
}

export function readState(id: string): State {
  const path = statePath(id);
  if (!existsSync(path)) throw new Error(`unknown pipeline: ${id}`);
  return upgrade(JSON.parse(readFileSync(path, "utf8")));
}

// State files written before `links` existed hold one `ref` (sometimes "A-1,A-2") and one `url`.
function upgrade(state: State & { ticket: { ref?: string; url?: string } }): State {
  const { ref, url, ...ticket } = state.ticket;
  if (ticket.links) return state;
  const refs = ref?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  return { ...state, ticket: { ...ticket, links: refs.map((r, i) => (i === 0 && url ? { ref: r, url } : { ref: r })) } };
}

// Write to a temp file then rename, so the dashboard never reads half a file.
export function writeState(state: State): void {
  state.updatedAt = new Date().toISOString();
  const path = statePath(state.id);
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export function updateState(id: string, change: (s: State) => void): State {
  const state = readState(id);
  change(state);
  writeState(state);
  return state;
}

export function listStates(): State[] {
  const dir = join(home(), "pipelines");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(statePath(id)))
    .map(readState)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function setStep(id: string, name: StepName, status: StepStatus): State {
  if (!STEPS.includes(name)) throw new Error(`unknown step: ${name} (expected ${STEPS.join(", ")})`);
  return updateState(id, (s) => {
    const step = s.steps.find((x) => x.name === name)!;
    const now = new Date().toISOString();
    step.status = status;
    if (status === "running") {
      step.startedAt = now;
      s.step = name;
      if (s.status === "waiting_for_user") s.status = "running";
    }
    if (status === "done" || status === "failed") step.endedAt = now;
    if (status === "failed") s.status = "failed";
    // A skipped preview never reaches the code that marks the pipeline ready.
    const finished = s.steps.every((x) => x.status === "done" || x.status === "skipped");
    if (finished && (s.status === "running" || s.status === "waiting_for_user")) s.status = "ready";
  });
}

export function upsertChunk(id: string, chunk: Chunk): State {
  return updateState(id, (s) => {
    const existing = s.chunks.find((c) => c.name === chunk.name);
    if (existing) Object.assign(existing, chunk);
    else s.chunks.push(chunk);
  });
}
