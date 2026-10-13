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

export interface State {
  id: string;
  ticket: { source: string; ref?: string; url?: string; title: string };
  repo: string;
  mode: Mode;
  status: Status;
  step: StepName;
  steps: { name: StepName; status: StepStatus; startedAt?: string; endedAt?: string }[];
  chunks: Chunk[];
  preview?: { url: string; port: number; pid: number; worktree: string; log: string };
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
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
  return text.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "ticket";
}

export function createPipeline(opts: {
  repo: string;
  title: string;
  source: string;
  ref?: string;
  url?: string;
  mode?: Mode;
  skip?: StepName[];
}): State {
  const now = new Date().toISOString();
  const base = `${now.slice(0, 10)}-${slug(opts.ref ?? opts.title)}`;
  let id = base;
  for (let n = 2; existsSync(pipelineDir(id)); n++) id = `${base}-${n}`;

  const mode = opts.mode ?? "full";
  const skipped = new Set([...(mode === "quick" ? QUICK_SKIPS : []), ...(opts.skip ?? [])]);
  const state: State = {
    id,
    ticket: { source: opts.source, ref: opts.ref, url: opts.url, title: opts.title },
    repo: opts.repo,
    mode,
    status: "running",
    step: STEPS[0],
    steps: STEPS.map((name) => ({ name, status: skipped.has(name) ? "skipped" : "pending" })),
    chunks: [],
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
  return JSON.parse(readFileSync(path, "utf8"));
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
