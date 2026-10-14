import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertRepoName, findRepo, repoName } from "./repos.ts";

export const STEPS = ["explore", "questions", "plan", "implement", "review", "stack", "preview"] as const;
export type StepName = (typeof STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export const STATUSES = ["running", "waiting_for_user", "ready", "done", "failed", "archived"] as const;
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
}

// Chunk.status stays free text; the merge engine writes this value.
export const MERGED = "merged";

// True when the pipeline has PRs and all of them are merged. Server and dashboard share it.
export function allMerged(p: Pick<State, "chunks">): boolean {
  const prChunks = p.chunks.filter((c) => c.pr);
  return prChunks.length > 0 && prChunks.every((c) => c.status === MERGED);
}
// Written by the dashboard's PR sync for a PR closed without merge.
export const CLOSED = "closed";

export type MergeStatus = "running" | "done" | "failed";
export type MergeMode = "combine" | "base";
export interface MergeRun {
  status: MergeStatus;
  repo: string; // Repo.path whose stack this run merges
  mode: MergeMode; // "combine" folds the stack into the bottom PR; "base" squash-merges the last PR into the base branch
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
  status: Status;
  waitingFor?: string; // the question the user must answer, set by `pipeship wait`
  step: StepName;
  steps: { name: StepName; status: StepStatus; startedAt?: string; endedAt?: string }[];
  chunks: Chunk[];
  preview?: { url: string; port: number; pid?: number; log: string; services?: PreviewService[] };
  session?: Session;
  previewError?: string; // why the last dashboard "Start preview" failed
  merge?: MergeRun; // last "Merge stack" run from the dashboard
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
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

type Raw = State & { repo?: string; base?: string; ticket: { ref?: string; url?: string } };

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
  // "stopped" became "archived", and "ready" used to hold without a preview.
  const old = raw.status as string;
  if (old === "stopped") raw.status = "archived";
  else if (old === "ready" && !raw.preview) raw.status = "done";
  // Merge runs saved before combine mode existed were all base merges.
  if (raw.merge && !raw.merge.mode) raw.merge.mode = "base";
  // State files written before `links` existed hold one `ref` (sometimes "A-1,A-2") and one `url`.
  const { ref, url, ...ticket } = raw.ticket;
  if (ticket.links) return raw;
  const refs = ref?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  return { ...raw, ticket: { ...ticket, links: refs.map((r, i) => (i === 0 && url ? { ref: r, url } : { ref: r })) } };
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

export function setStep(id: string, name: StepName, status: StepStatus): State {
  if (!STEPS.includes(name)) throw new Error(`unknown step: ${name} (expected ${STEPS.join(", ")})`);
  return updateState(id, (s) => {
    const step = s.steps.find((x) => x.name === name)!;
    const now = new Date().toISOString();
    step.status = status;
    if (status === "running") {
      step.startedAt = now;
      delete step.endedAt; // a step run again is not finished
      s.step = name;
    }
    // The wait ends when any step starts or when the step it blocked moves on.
    if (s.status === "waiting_for_user" && (status === "running" || name === s.step)) {
      s.status = "running";
      delete s.waitingFor;
    }
    if (status === "done" || status === "failed") step.endedAt = now;
    if (status === "failed") s.status = "failed";
    // Ready means a preview runs. A skipped preview leaves the pipeline done.
    const finished = s.steps.every((x) => x.status === "done" || x.status === "skipped");
    if (finished && (s.status === "running" || s.status === "waiting_for_user")) s.status = s.preview ? "ready" : "done";
  });
}

// A pause always names its step, so the dashboard shows which step waits.
export function waitForUser(id: string, name: StepName, reason?: string): State {
  if (!STEPS.includes(name)) throw new Error(`unknown step: ${name} (expected ${STEPS.join(", ")})`);
  return updateState(id, (s) => {
    const step = s.steps.find((x) => x.name === name)!;
    if (step.status === "done" || step.status === "skipped") throw new Error(`step ${name} is ${step.status}: nothing to wait on`);
    if (step.status !== "running") {
      step.status = "running";
      step.startedAt = new Date().toISOString();
      delete step.endedAt;
    }
    s.step = name;
    s.status = "waiting_for_user";
    if (reason) s.waitingFor = reason;
    else delete s.waitingFor;
  });
}

export function setStatus(id: string, status: Status): State {
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status} (expected ${STATUSES.join(", ")})`);
  return updateState(id, (s) => {
    if (status === "waiting_for_user" && !s.steps.some((x) => x.status === "running")) {
      throw new Error(`no step is running: use "pipeship wait ${id} <step>" to say which step waits`);
    }
    s.status = status;
    if (status !== "waiting_for_user") delete s.waitingFor;
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
    Object.assign(existing, chunk, { repo });
  });
}
