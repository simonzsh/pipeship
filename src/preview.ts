import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { home, listStates, pipelineDir, readState, updateState, type PreviewService, type State } from "./state.ts";

export interface ServiceRecipe {
  name: string;
  kind: string; // "front", "back" or any other word (treated like back)
  start: string;
  portEnv?: string;
  readyPath?: string;
  env?: Record<string, string>; // values may hold ${<service>.port}
  fixedPort?: number;
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
  env: Record<string, string>;
  fixedPort?: number;
}

type Preview = NonNullable<State["preview"]>;

export const FRONT_FIRST_PORT = 3000;
export const BACK_FIRST_PORT = 4000;
// The dashboard's port (server.ts DEFAULT_PORT). Not imported: server.ts imports this module.
export const DASHBOARD_PORT = 4400;
const PORT_SCAN = 1000;
const READY_TIMEOUT_MS = 180_000; // per service
const PORT_REF = /\$\{([A-Za-z0-9_-]+)\.port\}/g;

export function savedRecipePath(repo: string): string {
  return join(home(), "recipes", `${repo.replace(/^\/+/, "").replace(/[^a-zA-Z0-9.]+/g, "-")}.json`);
}

// A recipe shared in the repo wins over the one pipeship saved after a successful start.
export function findRecipe(repo: string, worktree?: string): string | undefined {
  const shared = [worktree, repo].filter((dir) => dir !== undefined).map((dir) => join(dir, ".pipeship.json"));
  return [...shared, savedRecipePath(repo)].find(existsSync);
}

export function loadRecipe(path: string): Recipe {
  const recipe = JSON.parse(readFileSync(path, "utf8")) as Recipe;
  normalizeRecipe(recipe, path);
  return recipe;
}

export function normalizeRecipe(recipe: Recipe, source = "recipe"): Service[] {
  if (recipe.services === undefined) {
    if (!recipe.start) throw new Error(`${source}: "start" or "services" is required`);
    const { start, portEnv, readyPath } = recipe;
    return [{ name: "app", kind: "front", start, portEnv: portEnv ?? "PORT", readyPath: readyPath ?? "/", env: {} }];
  }
  if (recipe.start) throw new Error(`${source}: use either "start" or "services", not both`);
  if (!Array.isArray(recipe.services) || recipe.services.length === 0) {
    throw new Error(`${source}: "services" must be a non-empty list`);
  }

  const services: Service[] = [];
  recipe.services.forEach((raw, index) => {
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
    for (const [key, value] of Object.entries(raw.env ?? {})) {
      if (typeof value !== "string") throw new Error(`${where}: env "${key}" must be a string`);
    }
    services.push({
      name,
      kind: raw.kind,
      start: raw.start,
      portEnv: raw.portEnv ?? (fixedPort === undefined ? "PORT" : undefined),
      readyPath: raw.readyPath ?? "/",
      env: raw.env ?? {},
      fixedPort,
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
): Promise<Record<string, number>> {
  const taken = new Set<number>([DASHBOARD_PORT]);
  for (const s of services) if (s.fixedPort !== undefined) taken.add(s.fixedPort);
  const ports: Record<string, number> = {};
  for (const s of services) {
    if (s.fixedPort !== undefined) {
      if (!(await isFree(s.fixedPort))) throw new Error(`service "${s.name}": fixed port ${s.fixedPort} is already in use`);
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
  return preview.services?.length ? preview.services.some((s) => isAlive(s.pid)) : isAlive(preview.pid);
}

export function previewLines(preview: Preview): string[] {
  const services = preview.services ?? [];
  return [preview.url, ...(services.length > 1 ? services.map((s) => `${s.name} (${s.kind}): ${s.url}`) : [])];
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

async function waitReady(url: string, pid: number, log: string, name: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) throw new Error(`service "${name}" exited before it was ready. Log tail:\n${tail(log)}`);
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`service "${name}" not ready after ${READY_TIMEOUT_MS / 1000}s. Log tail:\n${tail(log)}`);
}

// `draft` is a recipe written by the agent; it is saved for the repo only once the app starts.
export async function startPreview(id: string, worktree: string, draft?: string): Promise<State> {
  let state = readState(id);
  if (state.preview && previewAlive(state.preview)) await stopPreview(id);
  state = readState(id);

  const recipePath = draft ?? findRecipe(state.repo, worktree);
  if (!recipePath) throw new Error(`no recipe for ${state.repo}: write one and pass it with --recipe`);
  const recipe = loadRecipe(recipePath);
  const services = normalizeRecipe(recipe, recipePath);

  // A fixed port can serve one pipeline at a time.
  const fixed = services.find((s) => s.fixedPort !== undefined);
  if (fixed) {
    const other = listStates().find((s) => s.id !== id && s.repo === state.repo && s.preview && previewAlive(s.preview));
    if (other) {
      throw new Error(
        `service "${fixed.name}" uses the fixed port ${fixed.fixedPort}, and pipeline ${other.id} of this repo has a live test environment: stop it first (pipeship stop ${other.id})`,
      );
    }
  }

  for (const file of recipe.copyFiles ?? []) {
    const from = join(state.repo, file);
    const to = join(worktree, file);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }

  const installLog = join(pipelineDir(id), "preview.log");
  const installFd = openSync(installLog, "w");
  try {
    if (recipe.install) {
      const result = spawnSync("sh", ["-c", recipe.install], { cwd: worktree, stdio: ["ignore", installFd, installFd] });
      if (result.status !== 0) throw new Error(`install failed (${recipe.install}). Log tail:\n${tail(installLog)}`);
    }
  } finally {
    closeSync(installFd);
  }

  const ports = await pickPorts(services);
  const main = mainService(services);
  const started: PreviewService[] = [];
  try {
    for (const svc of startOrder(services)) {
      const port = ports[svc.name]!;
      const log = join(pipelineDir(id), `preview-${svc.name}.log`);
      const fd = openSync(log, "w");
      let pid: number;
      try {
        const child = spawn("sh", ["-c", svc.start], {
          cwd: worktree,
          detached: true,
          stdio: ["ignore", fd, fd],
          env: {
            ...process.env,
            ...resolveEnv(svc.env, ports),
            ...(svc.portEnv ? { [svc.portEnv]: String(port) } : {}),
          },
        });
        child.unref();
        pid = child.pid!;
      } finally {
        closeSync(fd);
      }
      started.push({ name: svc.name, kind: svc.kind, port, url: `http://localhost:${port}`, pid, log });

      // Save each pid as soon as it exists, so "stop" works even during a slow start.
      const mainStarted = started.find((x) => x.name === main.name);
      updateState(id, (s) => {
        s.preview = {
          url: `http://localhost:${ports[main.name]}`,
          port: ports[main.name]!,
          pid: (mainStarted ?? started[0]!).pid,
          worktree,
          log: installLog,
          services: [...started],
        };
      });
      await waitReady(`http://localhost:${port}${svc.readyPath}`, pid, log, svc.name);
    }
  } catch (err) {
    for (const svc of [...started].reverse()) await killGroup(svc.pid).catch(() => {});
    updateState(id, (s) => {
      s.preview = undefined;
    });
    throw err;
  }

  if (draft) {
    const saved = savedRecipePath(state.repo);
    mkdirSync(dirname(saved), { recursive: true });
    copyFileSync(draft, saved);
  }
  return updateState(id, (s) => {
    s.status = "ready";
    const step = s.steps.find((x) => x.name === "preview")!;
    step.status = "done";
    step.endedAt = new Date().toISOString();
  });
}

export async function stopPreview(id: string): Promise<void> {
  const { preview } = readState(id);
  if (preview) {
    const pids = preview.services?.length ? [...preview.services].reverse().map((s) => s.pid) : [preview.pid];
    const errors: string[] = [];
    for (const pid of pids) {
      if (!isAlive(pid)) continue;
      try {
        await killGroup(pid);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (errors.length) throw new Error(`could not stop the test servers: ${errors.join("; ")}`);
  }
  updateState(id, (s) => {
    s.preview = undefined;
  });
}

export async function stopPipeline(id: string): Promise<State> {
  updateState(id, (s) => {
    s.stopRequested = true;
  });
  await stopPreview(id);
  return updateState(id, (s) => {
    s.status = "stopped";
  });
}

// Deletes the worktrees and the pipeline's files. Branches and PRs stay: they live in the repo.
export async function deletePipeline(id: string, opts: { force?: boolean } = {}): Promise<void> {
  const state = readState(id);
  if (state.status === "running" || state.status === "waiting_for_user") {
    throw new Error("stop the pipeline before deleting it");
  }
  await stopPreview(id);

  const dir = join(pipelineDir(id), "worktrees");
  const worktrees = existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
  if (!opts.force) {
    const dirty = worktrees.filter((wt) => git(wt, "status", "--porcelain").stdout.trim() !== "");
    if (dirty.length) throw new Error(`uncommitted changes would be lost in: ${dirty.join(", ")}`);
  }
  for (const wt of worktrees) git(state.repo, "worktree", "remove", "--force", wt);
  rmSync(pipelineDir(id), { recursive: true, force: true });
  git(state.repo, "worktree", "prune");
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}
