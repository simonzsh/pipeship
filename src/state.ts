import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertRepoName, findRepo, repoName } from "./repos.ts";

export const STEPS = ["explore", "questions", "plan", "implement", "review", "stack", "preview"] as const;
export type StepName = (typeof STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export const STATUSES = ["running", "waiting_for_user", "ready", "done", "failed", "stopped", "archived"] as const;
export type Status = (typeof STATUSES)[number];
export type Mode = "full" | "quick";

export interface Repo {
  path: string; // git toplevel of the repo, absolute
  base?: string; // branch checked out when the repo was added; unset on a detached HEAD or outside git
}

export interface Chunk {
  name: string; // unique in the pipeline, across repos
  repo: string; // Repo.path of the repo this chunk's branch lives in
  worktree?: string;
  branch?: string;
  status?: string;
  pr?: string;
  prBase?: string; // base branch of the PR on GitHub, written by the PR sync; wins over the stack order
}

// Chunk.status stays free text; the merge engine writes this value.
export const MERGED = "merged";

// Written by the dashboard's PR sync for a PR closed without merge.
export const CLOSED = "closed";

// True when at least one PR is merged and every other PR is merged or closed. Server and dashboard share it.
export function allMerged(p: Pick<State, "chunks">): boolean {
  const prChunks = p.chunks.filter((c) => c.pr && c.status !== CLOSED);
  return prChunks.length > 0 && prChunks.every((c) => c.status === MERGED);
}

export type MergeStatus = "running" | "done" | "failed";
export interface MergeRun {
  status: MergeStatus;
  repo: string; // Repo.path whose stack this run merges
  pid?: number; // process that runs the merge (the dashboard server)
  current?: string; // name of the chunk being merged, or the one that stopped the merge
  message?: string; // progress, e.g. "waiting for checks on #12 (2 pending)"
  error?: string; // why it stopped (status "failed" only)
  startedAt: string;
  updatedAt: string; // refreshed on every progress write
  endedAt?: string;
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
  t3Thread?: T3Thread; // the T3 Code thread that runs the session, when there is one
}

export interface T3Thread {
  environmentId: string;
  threadId: string;
}

export interface State {
  id: string;
  // One pipeline can cover several tickets of the same source.
  // No source for a plain-text ticket.
  ticket: { source?: string; title: string; links: TicketLink[] };
  repos: Repo[];
  mode: Mode;
  status: Status; // derived by pipelineStatus on every write; never set by hand
  waiting?: { step: StepName; reason?: string }; // set by `pipeship wait`: the step that needs the user and why
  archivedAt?: string;
  step: StepName;
  steps: { name: StepName; status: StepStatus; startedAt?: string; endedAt?: string }[];
  chunks: Chunk[];
  preview?: { url: string; port: number; pid?: number; log: string; services?: PreviewService[] };
  session?: Session;
  previewError?: string; // why the last dashboard "Start preview" failed
  merges?: Record<string, MergeRun>; // last dashboard merge run per repo, keyed by Repo.path
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

// The only place that decides the status. Rule order matters: archived and failed win over stopped, then waiting.
export function pipelineStatus(s: Pick<State, "archivedAt" | "steps" | "stopRequested" | "waiting" | "preview">): Status {
  if (s.archivedAt) return "archived";
  if (s.steps.some((x) => x.status === "failed")) return "failed";
  if (s.stopRequested) return "stopped";
  if (s.waiting) return "waiting_for_user";
  if (s.steps.every((x) => x.status === "done" || x.status === "skipped")) return s.preview ? "ready" : "done";
  return "running";
}

export interface PreviewService {
  name: string;
  kind: string;
  port: number;
  url: string; // http://localhost:<port>
  pid?: number; // unset until the service is spawned
  log: string; // <pipelineDir>/preview-<name>.log
  repo: string; // Repo.path the service starts from
  worktree: string; // directory the service runs in
}

// Everything but the name is optional; `repo` may be a repo name or a path.
export type ChunkInput = { name: string } & Partial<Omit<Chunk, "name">>;

// Quick mode: a single chunk, so no separate plan/contracts step.
const QUICK_SKIPS: StepName[] = ["plan"];

export function home(): string {
  return process.env.PIPESHIP_HOME ?? join(homedir(), ".pipeship");
}

export function pipelineDir(id: string): string {
  return join(home(), "pipelines", id);
}

export function statePath(id: string): string {
  return join(pipelineDir(id), "state.json");
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ticket";
}

export function createPipeline(opts: {
  repos?: Repo[];
  title: string;
  name?: string;
  source?: string;
  links?: TicketLink[];
  mode?: Mode;
  skip?: StepName[];
  session?: Session;
}): State {
  const repos: Repo[] = [];
  for (const r of opts.repos ?? []) {
    if (repos.some((o) => o.path === r.path)) continue;
    assertRepoName(repos, r.path);
    repos.push(r);
  }
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
    ticket: { ...(opts.source && { source: opts.source }), title: opts.title, links },
    repos,
    mode,
    status: "running", // recomputed by writeState
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

type Raw = State & { merge?: MergeRun & { mode?: unknown }; repo?: string; base?: string; waitingFor?: string; ticket: { ref?: string; url?: string } };

// Runs on every read and must accept any old file.
function upgrade(raw: Raw): State {
  // Files from before multi-repo hold `repo` and `base` at the top level.
  if (!raw.repos) raw.repos = raw.repo ? [{ path: raw.repo, ...(raw.base && { base: raw.base }) }] : [];
  delete raw.repo;
  delete raw.base;
  const only = raw.repos.length === 1 ? raw.repos[0]!.path : undefined;
  const preview = raw.preview as (State["preview"] & { worktree?: string }) | undefined;
  if (only) {
    for (const c of raw.chunks) c.repo ??= only;
    if (raw.merge) raw.merge.repo ??= only;
    for (const svc of preview?.services ?? []) {
      svc.repo ??= only;
      svc.worktree ??= preview?.worktree ?? only;
    }
  }
  if (preview) delete preview.worktree;
  // The status used to be stored: archived and waiting were facts held only there.
  if (raw.status === "archived" && !raw.archivedAt) raw.archivedAt = raw.updatedAt;
  if (raw.status === "waiting_for_user" && !raw.waiting) raw.waiting = { step: raw.step, ...(raw.waitingFor && { reason: raw.waitingFor }) };
  delete raw.waitingFor;
  raw.status = pipelineStatus(raw);
  // One run per pipeline became one per repo; old runs also held a mode.
  if (raw.merge) {
    const { mode: _, ...run } = raw.merge;
    if (run.repo) (raw.merges ??= {})[run.repo] ??= run; // no repo with several repos: no key, dropped
    delete raw.merge;
  }
  // State files written before `links` existed hold one `ref` (sometimes "A-1,A-2") and one `url`.
  const { ref, url, ...ticket } = raw.ticket;
  if (ticket.links) return raw;
  const refs = ref?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  return { ...raw, ticket: { ...ticket, links: refs.map((r, i) => (i === 0 && url ? { ref: r, url } : { ref: r })) } };
}

export const LOCK_WAIT_MS = 2_000; // longest wait for a live lock, then throw
export const LOCK_STALE_MS = 10_000; // older than this = stale even if the pid is alive

export function lockPath(id: string): string {
  return join(pipelineDir(id), "state.lock");
}

const lockDepth = new Map<string, number>();
let seq = 0;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): { pid?: number; token?: string; raw: string } | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    try {
      const j = JSON.parse(raw);
      return { pid: typeof j?.pid === "number" ? j.pid : undefined, token: typeof j?.token === "string" ? j.token : undefined, raw };
    } catch {
      return { raw };
    }
  } catch {
    return undefined;
  }
}

// Cross-process lock for read-modify-write on state.json. Sync on purpose: callers rely on no await in between.
export function withStateLock<T>(id: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const depth = lockDepth.get(id) ?? 0;
  if (depth > 0) {
    lockDepth.set(id, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(id, depth);
    }
  }
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const path = lockPath(id);
  const token = `${process.pid}-${Date.now()}-${++seq}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } catch (err) {
        rmSync(path, { force: true }); // an empty lock would block every writer until it is stale
        throw err;
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`unknown pipeline: ${id}`);
      if (code !== "EEXIST") throw err;
    }
    const held = readLock(path);
    let age = 0;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue; // lock vanished: retry at once
    }
    const stale = age > staleMs || (held?.pid !== undefined && !pidAlive(held.pid));
    if (stale) {
      // Re-check the token before unlink. The tiny race between check and unlink is accepted.
      if (readLock(path)?.raw === held?.raw) rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`state of ${id} is locked by pid ${held?.pid ?? "?"} (${path}); try again`);
    Bun.sleepSync(10);
  }
  lockDepth.set(id, 1);
  try {
    return fn();
  } finally {
    lockDepth.delete(id);
    if (readLock(path)?.token === token) rmSync(path, { force: true });
  }
}

// Write to a unique temp file then rename, so the dashboard never reads half a file. Callers hold the lock.
export function writeState(state: State): void {
  state.status = pipelineStatus(state);
  state.updatedAt = new Date().toISOString();
  const path = statePath(state.id);
  const tmp = `${path}.${process.pid}.${++seq}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function updateState(id: string, change: (s: State) => void): State {
  return withStateLock(id, () => {
    const state = readState(id);
    change(state);
    writeState(state);
    return state;
  });
}

// After /clear the session id changes: record the new one so later hook matches still work.
export function refreshSessionId(id: string, detected: Session | undefined): Session | undefined {
  const stored = readState(id).session;
  if (!stored || !detected || stored.harness !== detected.harness || stored.cwd !== detected.cwd || stored.id === detected.id) return stored;
  return updateState(id, (s) => {
    s.session!.id = detected.id;
    if (detected.t3Thread) s.session!.t3Thread = detected.t3Thread;
  }).session;
}

export function listStates(): State[] {
  const dir = join(home(), "pipelines");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(statePath(id)))
    .map(readState)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type DashboardState = State & { testGuide?: string; previewStarting?: boolean };

// The guide and the starting flag are for the API only: they never go into state.json.
export function listDashboardStates(isStarting: (id: string) => boolean = () => false): DashboardState[] {
  return listStates().map((s) => {
    const file = join(pipelineDir(s.id), "test.md");
    const d: DashboardState = existsSync(file) ? { ...s, testGuide: readFileSync(file, "utf8") } : { ...s };
    if (isStarting(s.id)) d.previewStarting = true;
    return d;
  });
}

// Switching to quick skips only the steps that have not started.
export function setMode(id: string, mode: Mode): State {
  if (mode !== "quick" && mode !== "full") throw new Error(`unknown mode: ${mode} (expected quick, full)`);
  return updateState(id, (s) => {
    s.mode = mode;
    if (mode !== "quick") return;
    for (const step of s.steps) if (QUICK_SKIPS.includes(step.name) && step.status === "pending") step.status = "skipped";
  });
}

// Every earlier step must be done or skipped. Called inside the lock, so a refusal writes nothing.
function assertPrerequisites(s: State, name: StepName, action: string): void {
  for (const prev of STEPS.slice(0, STEPS.indexOf(name))) {
    const status = s.steps.find((x) => x.name === prev)?.status;
    if (status !== "done" && status !== "skipped") {
      throw new Error(`cannot ${action}: ${prev} is ${status} (earlier steps must be done or skipped)`);
    }
  }
}

export function setStep(id: string, name: StepName, status: StepStatus): State {
  if (!STEPS.includes(name)) throw new Error(`unknown step: ${name} (expected ${STEPS.join(", ")})`);
  return updateState(id, (s) => {
    if (status === "running" || status === "done" || status === "failed") assertPrerequisites(s, name, `mark ${name} ${status}`);
    const step = s.steps.find((x) => x.name === name)!;
    const now = new Date().toISOString();
    step.status = status;
    if (status === "running") {
      step.startedAt = now;
      delete step.endedAt; // a step run again is not finished
      s.step = name;
    }
    // The wait ends when any step starts or when the step it blocked moves on.
    if (s.waiting && (status === "running" || name === s.waiting.step)) delete s.waiting;
    // A step that starts again resumes a stopped pipeline.
    // It also unarchives: the agent reopening an archived pipeline puts it back to work.
    if (status === "running") {
      s.stopRequested = false;
      delete s.archivedAt;
    }
    if (status === "done" || status === "failed") step.endedAt = now;
  });
}

// A pause always names its step, so the dashboard shows which step waits.
export function waitForUser(id: string, name: StepName, reason?: string): State {
  if (!STEPS.includes(name)) throw new Error(`unknown step: ${name} (expected ${STEPS.join(", ")})`);
  return updateState(id, (s) => {
    const step = s.steps.find((x) => x.name === name)!;
    if (step.status === "done" || step.status === "skipped") throw new Error(`step ${name} is ${step.status}: nothing to wait on`);
    assertPrerequisites(s, name, `wait on ${name}`);
    if (step.status !== "running") {
      step.status = "running";
      step.startedAt = new Date().toISOString();
      delete step.endedAt;
    }
    s.step = name;
    s.waiting = { step: name, ...(reason && { reason }) };
  });
}

// A repo by name or by path (relative paths resolved against cwd); throws when unknown.
export function lookupRepo(state: Pick<State, "repos">, ref: string): Repo {
  const repo = findRepo(state, ref) ?? findRepo(state, resolve(ref));
  if (repo) return repo;
  const known = state.repos.map((r) => repoName(r.path)).join(", ");
  throw new Error(`unknown repo: ${ref} (${known ? `repos: ${known}` : "the pipeline has no repo"})`);
}

// A path already in the pipeline is left as it is: its base does not change.
export function addRepo(id: string, repo: Repo): { state: State; added: boolean } {
  let added = false;
  const state = updateState(id, (s) => {
    if (s.repos.some((r) => r.path === repo.path)) return;
    assertRepoName(s.repos, repo.path);
    s.repos.push(repo);
    added = true;
  });
  return { state, added };
}

function newChunkRepo(s: State, chunk: ChunkInput): string {
  if (chunk.repo) return lookupRepo(s, chunk.repo).path;
  if (s.repos.length === 1) return s.repos[0]!.path;
  if (s.repos.length === 0) throw new Error(`pipeline ${s.id} has no repo: add one with pipeship repo ${s.id} <path>`);
  throw new Error(`chunk "${chunk.name}": --repo is required (repos: ${s.repos.map((r) => repoName(r.path)).join(", ")})`);
}

export function upsertChunk(id: string, chunk: ChunkInput): State {
  return updateState(id, (s) => {
    const existing = s.chunks.find((c) => c.name === chunk.name);
    if (!existing) {
      s.chunks.push({ ...chunk, repo: newChunkRepo(s, chunk) });
      return;
    }
    const repo = chunk.repo ? lookupRepo(s, chunk.repo).path : existing.repo;
    if (repo !== existing.repo) throw new Error(`chunk "${chunk.name}" belongs to ${repoName(existing.repo)}`);
    // A new PR has its own base: the sync reads it again.
    if (chunk.pr && chunk.pr !== existing.pr) delete existing.prBase;
    Object.assign(existing, chunk, { repo });
  });
}
