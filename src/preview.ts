import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, closeSync } from "node:fs";
import { connect, createServer } from "node:net";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { findRepo, repoName, sharesRepo, topChunk } from "./repos.ts";
import { allMerged, home, MERGED, listStates, pipelineDir, readState, updateState, type PreviewService, type Repo, type State } from "./state.ts";

export interface ServiceRecipe {
  name: string;
  kind: string; // "front", "back" or any other word (treated like back)
  start: string;
  portEnv?: string;
  readyPath?: string;
  ready?: "http" | "tcp"; // "tcp": ready as soon as the port accepts a connection (databases, queues)
  env?: Record<string, string>; // values may hold ${<service>.port}
  fixedPort?: number;
  repo?: string; // repo NAME (repoName of a pipeline repo)
  install?: string; // run in this service's worktree, before any service starts
  copyFiles?: string[]; // copied from this service's repo checkout into its worktree
}

export interface Recipe {
  install?: string;
  copyFiles?: string[];
  // Legacy single service: same as one front service named "app".
  start?: string;
  portEnv?: string;
  readyPath?: string;
  services?: ServiceRecipe[];
}

export interface Service {
  name: string;
  kind: string;
  start: string;
  portEnv?: string;
  readyPath: string;
  ready: "http" | "tcp";
  env: Record<string, string>;
  fixedPort?: number;
  repo?: string;
  install?: string;
  copyFiles?: string[];
}

type Preview = NonNullable<State["preview"]>;

export const FRONT_FIRST_PORT = 3000;
export const BACK_FIRST_PORT = 4000;
// The dashboard's port (server.ts DEFAULT_PORT). Not imported: server.ts imports this module.
export const DASHBOARD_PORT = 4400;
const PORT_SCAN = 1000;
const READY_TIMEOUT_MS = 180_000; // per service
const PORT_REF = /\$\{([A-Za-z0-9_-]+)\.port\}/g;

export function savedRecipePath(repos: string[]): string {
  if (repos.length === 1) {
    return join(home(), "recipes", `${repos[0]!.replace(/^\/+/, "").replace(/[^a-zA-Z0-9.]+/g, "-")}.json`);
  }
  // Sorted, so the same set of repos gives the same file in any order.
  const sorted = [...repos].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 8);
  return join(home(), "recipes", `${sorted.map(repoName).join("+")}-${hash}.json`);
}

// A recipe shared in the repo wins over the one pipeship saved after a successful start.
// Several repos have no shared place: only the saved recipe counts.
export function findRecipe(repos: string[], worktree?: string): string | undefined {
  const saved = savedRecipePath(repos);
  if (repos.length !== 1) return existsSync(saved) ? saved : undefined;
  const shared = [worktree, repos[0]].filter((dir) => dir !== undefined).map((dir) => join(dir, ".pipeship.json"));
  return [...shared, saved].find(existsSync);
}

export function loadRecipe(path: string): Recipe {
  const recipe = JSON.parse(readFileSync(path, "utf8")) as Recipe;
  normalizeRecipe(recipe, path);
  return recipe;
}

// `repos` are repo NAMES; when given, the repo rules of the pipeline apply.
export function normalizeRecipe(recipe: Recipe, source = "recipe", repos?: string[]): Service[] {
  const several = (repos?.length ?? 0) >= 2;
  if (several && recipe.services === undefined && recipe.start) {
    throw new Error(`${source}: a recipe for several repos needs "services", each with a "repo"`);
  }
  if (several && (recipe.install !== undefined || recipe.copyFiles !== undefined)) {
    throw new Error(`${source}: top-level "install" and "copyFiles" need a single repo: set them on the services`);
  }
  if (recipe.services === undefined) {
    if (!recipe.start) throw new Error(`${source}: "start" or "services" is required`);
    const { start, portEnv, readyPath } = recipe;
    if (readyPath !== undefined && !(typeof readyPath === "string" && readyPath.startsWith("/"))) {
      throw new Error(`${source}: "readyPath" must start with "/"`);
    }
    return [{ name: "app", kind: "front", start, portEnv: portEnv ?? "PORT", readyPath: readyPath ?? "/", ready: "http", env: {} }];
  }
  if (recipe.start) throw new Error(`${source}: use either "start" or "services", not both`);
  if (!Array.isArray(recipe.services) || recipe.services.length === 0) {
    throw new Error(`${source}: "services" must be a non-empty list`);
  }

  const services: Service[] = [];
  recipe.services.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${source}: service #${index + 1} must be an object`);
    }
    const { name } = raw;
    if (!name) throw new Error(`${source}: service #${index + 1} needs a "name"`);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`${source}: service name "${name}" may only use letters, digits, "-" and "_"`);
    }
    if (services.some((s) => s.name === name)) throw new Error(`${source}: duplicate service name "${name}"`);
    const where = `${source}: service "${name}"`;
    if (!raw.start) throw new Error(`${where}: "start" is required`);
    if (!raw.kind) throw new Error(`${where}: "kind" is required`);
    const { fixedPort } = raw;
    if (fixedPort !== undefined && !(Number.isInteger(fixedPort) && fixedPort >= 1 && fixedPort <= 65535)) {
      throw new Error(`${where}: "fixedPort" must be a port number`);
    }
    if (raw.readyPath !== undefined && !(typeof raw.readyPath === "string" && raw.readyPath.startsWith("/"))) {
      throw new Error(`${where}: "readyPath" must start with "/"`);
    }
    if (raw.ready !== undefined && raw.ready !== "http" && raw.ready !== "tcp") {
      throw new Error(`${where}: "ready" must be "http" or "tcp"`);
    }
    if (raw.env !== undefined && (typeof raw.env !== "object" || raw.env === null || Array.isArray(raw.env))) {
      throw new Error(`${where}: "env" must be an object`);
    }
    if (raw.repo !== undefined && !(typeof raw.repo === "string" && raw.repo)) {
      throw new Error(`${where}: "repo" must be a repo name`);
    }
    if (raw.install !== undefined && typeof raw.install !== "string") throw new Error(`${where}: "install" must be a string`);
    if (raw.copyFiles !== undefined && !(Array.isArray(raw.copyFiles) && raw.copyFiles.every((f) => typeof f === "string"))) {
      throw new Error(`${where}: "copyFiles" must be a list of file paths`);
    }
    if (repos && several && raw.repo === undefined) {
      throw new Error(`${where}: "repo" is required when the pipeline has several repos (${repos.join(", ")})`);
    }
    if (repos && raw.repo !== undefined && !repos.includes(raw.repo)) {
      throw new Error(`${where}: unknown repo "${raw.repo}" (repos: ${repos.join(", ")})`);
    }
    const other = fixedPort === undefined ? undefined : services.find((s) => s.fixedPort === fixedPort);
    if (other) throw new Error(`${where}: fixed port ${fixedPort} is already used by "${other.name}"`);
    for (const [key, value] of Object.entries(raw.env ?? {})) {
      if (typeof value !== "string") throw new Error(`${where}: env "${key}" must be a string`);
    }
    services.push({
      name,
      kind: raw.kind,
      start: raw.start,
      portEnv: raw.portEnv ?? (fixedPort === undefined ? "PORT" : undefined),
      readyPath: raw.readyPath ?? "/",
      ready: raw.ready ?? "http",
      env: raw.env ?? {},
      fixedPort,
      ...(raw.repo !== undefined && { repo: raw.repo }),
      ...(raw.install !== undefined && { install: raw.install }),
      ...(raw.copyFiles !== undefined && { copyFiles: raw.copyFiles }),
    });
  });

  // Second pass: a service may refer to one declared after it.
  for (const service of services) {
    for (const [key, value] of Object.entries(service.env)) {
      for (const match of value.matchAll(PORT_REF)) {
        const where = `${source}: service "${service.name}": env "${key}"`;
        if (match[1] === service.name) throw new Error(`${where} refers to its own port`);
        if (!services.some((s) => s.name === match[1])) throw new Error(`${where} refers to unknown service "${match[1]}"`);
      }
    }
  }
  return services;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

// Every port is picked before anything starts, so env templates resolve and no two services share a port.
export async function pickPorts(
  services: Service[],
  isFree: (port: number) => Promise<boolean> = portIsFree,
  reserved: Set<number> = new Set(),
): Promise<Record<string, number>> {
  const taken = new Set<number>([DASHBOARD_PORT, ...reserved]);
  for (const s of services) if (s.fixedPort !== undefined) taken.add(s.fixedPort);
  const ports: Record<string, number> = {};
  for (const s of services) {
    if (s.fixedPort !== undefined) {
      if (reserved.has(s.fixedPort) || !(await isFree(s.fixedPort))) throw new Error(`service "${s.name}": fixed port ${s.fixedPort} is already in use`);
      ports[s.name] = s.fixedPort;
      continue;
    }
    const from = s.kind === "front" ? FRONT_FIRST_PORT : BACK_FIRST_PORT;
    let found: number | undefined;
    for (let port = from; port < from + PORT_SCAN && found === undefined; port++) {
      if (!taken.has(port) && (await isFree(port))) found = port;
    }
    if (found === undefined) throw new Error(`service "${s.name}": no free port from ${from} to ${from + PORT_SCAN - 1}`);
    taken.add(found);
    ports[s.name] = found;
  }
  return ports;
}

export function resolveEnv(env: Record<string, string>, ports: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(PORT_REF, (_, name: string) => {
      if (ports[name] === undefined) throw new Error(`env "${key}" refers to unknown service "${name}"`);
      return String(ports[name]);
    });
  }
  return out;
}

// Back ends and other kinds first, then fronts: a front can call them as soon as it starts.
export function startOrder<T extends { kind: string }>(services: T[]): T[] {
  return [...services.filter((s) => s.kind !== "front"), ...services.filter((s) => s.kind === "front")];
}

export function mainService<T extends { kind: string }>(services: T[]): T {
  return services.find((s) => s.kind === "front") ?? services[0]!;
}

export function previewAlive(preview: Preview): boolean {
  const pids = preview.services?.length ? preview.services.map((s) => s.pid) : [preview.pid];
  return pids.some((pid) => pid !== undefined && isAlive(pid));
}

// Ports are planned before install, so a pipeline can hold ports while no process runs yet.
function previewStarting(preview: Preview): boolean {
  return preview.services?.some((s) => s.pid === undefined) ?? false;
}

function reservedPorts(id: string): Set<number> {
  const ports = new Set<number>();
  for (const s of listStates()) {
    if (s.id === id || !s.preview) continue;
    ports.add(s.preview.port);
    for (const svc of s.preview.services ?? []) ports.add(svc.port);
  }
  return ports;
}

export function previewLines(preview: Preview): string[] {
  const services = preview.services ?? [];
  const several = new Set(services.map((s) => s.repo)).size > 1;
  const label = (s: PreviewService) => `${s.name} (${s.kind}${several ? `, ${repoName(s.repo)}` : ""})`;
  return [preview.url, ...(services.length > 1 ? services.map((s) => `${label(s)}: ${s.url}`) : [])];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The server runs in its own process group: killing the group also stops
// the workers that dev servers spawn (Next.js, Vite...).
export async function killGroup(pid: number): Promise<void> {
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {}
  };
  send("SIGTERM");
  for (let i = 0; i < 50 && isAlive(pid); i++) await Bun.sleep(100);
  if (isAlive(pid)) send("SIGKILL");
  for (let i = 0; i < 20 && isAlive(pid); i++) await Bun.sleep(100);
  if (isAlive(pid)) throw new Error(`process ${pid} is still running`);
}

function tail(path: string, lines = 30): string {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-lines).join("\n") : "";
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "localhost" });
    socket.setTimeout(5000);
    socket.once("connect", () => socket.destroy(void resolve(true)));
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => socket.destroy(void resolve(false)));
  });
}

async function waitReady(svc: Service, port: number, pid: number, log: string): Promise<void> {
  const { name } = svc;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) throw new Error(`service "${name}" exited before it was ready. Log tail:\n${tail(log)}`);
    try {
      if (svc.ready === "tcp") {
        if (await tcpOpen(port)) return;
      } else {
        await fetch(`http://localhost:${port}${svc.readyPath}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        return;
      }
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`service "${name}" not ready after ${READY_TIMEOUT_MS / 1000}s. Log tail:\n${tail(log)}`);
}

type Homes = Map<string, { repo: string; worktree: string }>;

// Never overwrites a file the worktree already has.
function copyFrom(repo: string, worktree: string, files: string[] = []): void {
  for (const file of files) {
    const from = join(repo, file);
    const to = join(worktree, file);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

function copyAll(recipe: Recipe, services: Service[], homes: Homes): void {
  const first = homes.get(services[0]!.name)!;
  copyFrom(first.repo, first.worktree, recipe.copyFiles); // top-level: one repo only
  for (const svc of services) copyFrom(homes.get(svc.name)!.repo, homes.get(svc.name)!.worktree, svc.copyFiles);
}

// Top-level install first, then each service's, once per worktree and command.
function runInstalls(recipe: Recipe, services: Service[], homes: Homes, log: string, several: boolean): void {
  const first = homes.get(services[0]!.name)!;
  const jobs = [
    ...(recipe.install ? [{ cmd: recipe.install, ...first }] : []),
    ...services.filter((s) => s.install).map((s) => ({ cmd: s.install!, ...homes.get(s.name)! })),
  ];
  const done = new Set<string>();
  const fd = openSync(log, "w");
  try {
    for (const job of jobs) {
      const key = `${job.worktree}\0${job.cmd}`;
      if (done.has(key)) continue;
      done.add(key);
      const result = spawnSync("sh", ["-c", job.cmd], { cwd: job.worktree, stdio: ["ignore", fd, fd] });
      if (result.status !== 0) {
        throw new Error(`install failed (${job.cmd})${several ? ` in ${repoName(job.repo)}` : ""}. Log tail:\n${tail(log)}`);
      }
    }
  } finally {
    closeSync(fd);
  }
}

// `draft` is a recipe written by the agent; it is saved for the repos only once the app starts.
export async function startPreview(id: string, worktree?: string, draft?: string): Promise<State> {
  let state = readState(id);
  if (state.preview && previewAlive(state.preview)) await stopPreview(id);
  state = readState(id);

  const { repos } = state;
  if (repos.length === 0) throw new Error(`pipeline ${id} has no repo: add one with pipeship repo ${id} <path>`);
  if (worktree && repos.length > 1) {
    throw new Error(`pipeline ${id} has several repos: drop ${worktree}, each repo's worktree comes from its chunks`);
  }
  const paths = repos.map((r) => r.path);
  const trees = new Map(repos.map((r) => [r.path, (repos.length === 1 && worktree) || topChunk(state, r.path)?.worktree]));

  const recipePath = draft ?? findRecipe(paths, repos.length === 1 ? trees.get(paths[0]!) : undefined);
  if (!recipePath) throw new Error(`no recipe for ${paths.join(" + ")}: write one and pass it with --recipe`);
  const recipe = loadRecipe(recipePath);
  const services = normalizeRecipe(recipe, recipePath, paths.map(repoName));

  // Each service runs in the worktree of its repo.
  const homes = new Map(services.map((svc) => {
    const repo = svc.repo ? findRepo(state, svc.repo)! : repos[0]!;
    const tree = trees.get(repo.path);
    if (!tree) {
      throw new Error(`service "${svc.name}": no worktree for repo ${repoName(repo.path)}: record one with pipeship chunk ${id} <chunk> --repo ${repoName(repo.path)} --worktree <path>`);
    }
    return [svc.name, { repo: repo.path, worktree: tree }];
  }));

  // A fixed port can serve one pipeline at a time: a live or still-starting one blocks it.
  const fixed = services.find((s) => s.fixedPort !== undefined);
  if (fixed) {
    const other = listStates().find(
      (s) => s.id !== id && sharesRepo(s, state) && s.preview && (previewAlive(s.preview) || previewStarting(s.preview)),
    );
    if (other) {
      const shared = repoName(other.repos.find((r) => paths.includes(r.path))!.path);
      throw new Error(
        `service "${fixed.name}" uses the fixed port ${fixed.fixedPort}, and pipeline ${other.id} of the repo ${shared} has a live preview: stop it first (pipeship stop ${other.id})`,
      );
    }
  }

  // Reserve the ports before the (slow) install, so another pipeline cannot pick them meanwhile.
  const installLog = join(pipelineDir(id), "preview.log");
  const ports = await pickPorts(services, portIsFree, reservedPorts(id));
  const main = mainService(services);
  const order = startOrder(services);
  const mainUrl = `http://localhost:${ports[main.name]}`;
  const planned: PreviewService[] = order.map((svc) => ({
    name: svc.name,
    kind: svc.kind,
    port: ports[svc.name]!,
    url: `http://localhost:${ports[svc.name]}`,
    log: join(pipelineDir(id), `preview-${svc.name}.log`),
    ...homes.get(svc.name)!,
  }));
  const preview = (mainPid?: number) =>
    ({ url: mainUrl, port: ports[main.name]!, pid: mainPid, log: installLog, services: planned });
  updateState(id, (s) => {
    s.preview = preview();
  });

  const started: PreviewService[] = [];
  // Roll back: kill what started (reverse), clear the preview, and report what would not die.
  const abort = async (err: Error): Promise<never> => {
    const errors: string[] = [];
    for (const svc of [...started].reverse()) {
      await killGroup(svc.pid!).catch((e: Error) => errors.push(e.message));
    }
    updateState(id, (s) => {
      s.preview = undefined;
    });
    if (errors.length) err.message += `; could not stop: ${errors.join("; ")}`;
    throw err;
  };

  try {
    copyAll(recipe, services, homes);
    runInstalls(recipe, services, homes, installLog, repos.length > 1);

    for (const svc of order) {
      // A stop during a slow install or readiness wait must not leave a service behind.
      if (!readState(id).preview) throw new Error("stopped while starting");
      const plan = planned.find((p) => p.name === svc.name)!;
      const fd = openSync(plan.log, "w");
      try {
        const child = spawn("sh", ["-c", svc.start], {
          cwd: plan.worktree,
          detached: true,
          stdio: ["ignore", fd, fd],
          env: {
            ...process.env,
            ...resolveEnv(svc.env, ports),
            ...(svc.portEnv ? { [svc.portEnv]: String(plan.port) } : {}),
          },
        });
        child.unref();
        plan.pid = child.pid!;
      } finally {
        closeSync(fd);
      }
      started.push(plan);

      // Save each pid as soon as it exists, so "stop" works even during a slow start.
      // A stop clears the preview: never bring it back, the check below then aborts.
      const mainPid = (started.find((x) => x.name === main.name) ?? started[0]!).pid;
      updateState(id, (s) => {
        if (s.preview) s.preview = preview(mainPid);
      });
      await waitReady(svc, plan.port, plan.pid!, plan.log);
    }
    if (!readState(id).preview) throw new Error("stopped while starting");
  } catch (err) {
    return abort(err as Error);
  }

  if (draft) {
    const saved = savedRecipePath(paths);
    mkdirSync(dirname(saved), { recursive: true });
    copyFileSync(draft, saved);
  }
  return updateState(id, (s) => {
    const step = s.steps.find((x) => x.name === "preview")!;
    step.status = "done";
    step.endedAt = new Date().toISOString();
  });
}

export async function stopPreview(id: string): Promise<void> {
  if (startsInFlight.has(id)) stoppedMidStart.add(id);
  const errors: string[] = [];
  const killed = new Set<number>();
  const killAll = async (preview: Preview | undefined) => {
    if (!preview) return;
    const pids = preview.services?.length ? [...preview.services].reverse().map((s) => s.pid) : [preview.pid];
    for (const pid of pids) {
      if (pid === undefined || killed.has(pid) || !isAlive(pid)) continue;
      killed.add(pid);
      try {
        await killGroup(pid);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  };
  await killAll(readState(id).preview);
  // A start in progress may have spawned a service while we were killing.
  await killAll(readState(id).preview);
  if (errors.length) throw new Error(`could not stop the preview: ${errors.join("; ")}`);
  updateState(id, (s) => {
    s.preview = undefined;
  });
}

export class PreviewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// One dashboard-started preview per pipeline, like merge's `active` set.
const startsInFlight = new Set<string>();
// Killing a service mid-start can fail the start with another message: remember the stop.
const stoppedMidStart = new Set<string>();

// The dashboard cannot wait minutes for a start: failures go to state.previewError instead.
export const isPreviewStarting = (id: string) => startsInFlight.has(id);
export const anyPreviewStarting = () => startsInFlight.size > 0;

function readStateOr404(id: string): State {
  try {
    return readState(id);
  } catch (err) {
    throw new PreviewError((err as Error).message, 404);
  }
}

export function requestPreviewStart(id: string): { state: State; done: Promise<void> } {
  const state = readStateOr404(id);
  if (state.status !== "done") throw new PreviewError("the pipeline is not done: no preview to start", 409);
  if (startsInFlight.has(id)) throw new PreviewError("a preview is already starting", 409);
  // Before the guard is set: a throw here must not leave the id marked in flight.
  const cleared = updateState(id, (s) => {
    delete s.previewError;
  });
  startsInFlight.add(id);
  stoppedMidStart.delete(id);
  const done = startPreview(id)
    .then(() => undefined)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // A stop during the start is the user's own choice, not a failure.
      if (message === "stopped while starting" || stoppedMidStart.has(id)) return;
      updateState(id, (s) => {
        s.previewError = message;
      });
    })
    .finally(() => {
      startsInFlight.delete(id);
      stoppedMidStart.delete(id);
    });
  return { state: cleared, done };
}

export async function stopPipeline(id: string): Promise<State> {
  updateState(id, (s) => {
    s.stopRequested = true;
    delete s.waiting;
  });
  await stopPreview(id);
  return readState(id);
}

// The "Stop preview" button: with no preview left, a ready pipeline derives back to done.
export async function stopPreviewAndSettle(id: string): Promise<State> {
  await stopPreview(id);
  return readState(id);
}

// Archiving stops the preview; unarchiving does not restart it.
export async function archivePipeline(id: string): Promise<State> {
  const state = readStateOr404(id);
  if (!["done", "failed", "stopped"].includes(state.status)) {
    throw new PreviewError(`only a done, failed or stopped pipeline can be archived (status: ${state.status})`, 409);
  }
  await stopPreview(id);
  return updateState(id, (s) => {
    s.archivedAt = new Date().toISOString();
  });
}

// The status derives again from the facts: done, failed or stopped.
export async function unarchivePipeline(id: string): Promise<State> {
  const state = readStateOr404(id);
  if (state.status !== "archived") throw new PreviewError(`only an archived pipeline can be unarchived (status: ${state.status})`, 409);
  return updateState(id, (s) => void delete s.archivedAt);
}

// Once every PR is merged the pipeline has no work left. Never throws: callers are the merge and the PR sync.
const archivable = (s: State) => ["ready", "done", "failed", "stopped"].includes(s.status) && s.merge?.status !== "running" && allMerged(s);

export async function archiveIfAllMerged(id: string): Promise<boolean> {
  try {
    if (!archivable(readState(id))) return false;
    // Archive before the stop: the merge can run in this pipeline's own preview server, which the stop kills.
    const after = updateState(id, (x) => {
      if (archivable(x)) x.archivedAt = new Date().toISOString();
    });
    if (after.status !== "archived") return false;
    try {
      await stopPreview(id);
    } catch (err) {
      console.error(`auto-archive ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  } catch (err) {
    console.error(`auto-archive ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// The worktree folders are flat: try each repo until one owns the worktree.
function removeWorktree(repos: Repo[], wt: string): void {
  repos.some((repo) => git(repo.path, "worktree", "remove", "--force", wt).status === 0);
}

// Deletes the worktrees and the pipeline's files, then the local branches of merged chunks.
// Unmerged branches and the PRs stay: they live in the repo. -D is safe here: a squash merge
// leaves the branch "unmerged" for git, but GitHub already holds its work.
export async function deletePipeline(id: string, opts: { force?: boolean } = {}): Promise<void> {
  const state = readState(id);
  if (state.status === "running" || state.status === "waiting_for_user") {
    throw new Error("stop the pipeline before deleting it");
  }
  if (state.merge?.status === "running") throw new Error("wait for the merge to finish before deleting");
  await stopPreview(id);

  const dir = join(pipelineDir(id), "worktrees");
  const worktrees = existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
  if (!opts.force) {
    const dirty = worktrees.filter((wt) => git(wt, "status", "--porcelain").stdout.trim() !== "");
    if (dirty.length) throw new Error(`uncommitted changes would be lost in: ${dirty.join(", ")}`);
  }
  for (const wt of worktrees) removeWorktree(state.repos, wt);
  rmSync(pipelineDir(id), { recursive: true, force: true });
  for (const repo of state.repos) git(repo.path, "worktree", "prune");
  for (const c of state.chunks) {
    const base = state.repos.find((r) => r.path === c.repo)?.base;
    if (c.status === MERGED && c.branch && c.branch !== base) git(c.repo, "branch", "-D", c.branch);
  }
}

export function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}
