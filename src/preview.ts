import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { home, pipelineDir, readState, updateState, type State } from "./state.ts";

export interface Recipe {
  install?: string;
  start: string;
  portEnv?: string;
  copyFiles?: string[];
  readyPath?: string;
}

const FIRST_PORT = 3100;
const READY_TIMEOUT_MS = 180_000;

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
  if (!recipe.start) throw new Error(`${path}: "start" is required`);
  return recipe;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

export async function findFreePort(from = FIRST_PORT): Promise<number> {
  for (let port = from; port < from + 1000; port++) if (await portIsFree(port)) return port;
  throw new Error("no free port found");
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

function hostLabel(state: State): string {
  return (state.ticket.links[0]?.ref ?? state.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

function tail(path: string, lines = 30): string {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-lines).join("\n") : "";
}

async function waitReady(url: string, pid: number, log: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) throw new Error(`server exited before it was ready. Log tail:\n${tail(log)}`);
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`server not ready after ${READY_TIMEOUT_MS / 1000}s. Log tail:\n${tail(log)}`);
}

// Some dev servers reject unknown hosts (e.g. Vite's allowedHosts) with 400 or 403.
async function acceptsHost(url: string, host: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Host: host }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    return res.status !== 400 && res.status !== 403;
  } catch {
    return false;
  }
}

// `draft` is a recipe written by the agent; it is saved for the repo only once the app starts.
export async function startPreview(id: string, worktree: string, draft?: string): Promise<State> {
  let state = readState(id);
  if (state.preview && isAlive(state.preview.pid)) await stopPreview(id);
  state = readState(id);

  const recipePath = draft ?? findRecipe(state.repo, worktree);
  if (!recipePath) throw new Error(`no recipe for ${state.repo}: write one and pass it with --recipe`);
  const recipe = loadRecipe(recipePath);
  for (const file of recipe.copyFiles ?? []) {
    const from = join(state.repo, file);
    const to = join(worktree, file);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }

  const log = join(pipelineDir(id), "preview.log");
  const fd = openSync(log, "w");
  try {
    if (recipe.install) {
      const result = spawnSync("sh", ["-c", recipe.install], { cwd: worktree, stdio: ["ignore", fd, fd] });
      if (result.status !== 0) throw new Error(`install failed (${recipe.install}). Log tail:\n${tail(log)}`);
    }

    const port = await findFreePort();
    const child = spawn("sh", ["-c", recipe.start], {
      cwd: worktree,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, [recipe.portEnv ?? "PORT"]: String(port) },
    });
    child.unref();
    const pid = child.pid!;
    const host = `${hostLabel(state)}.localhost:${port}`;
    const readyUrl = `http://localhost:${port}${recipe.readyPath ?? "/"}`;

    // Save the pid before waiting, so "stop" works even during a slow start.
    updateState(id, (s) => {
      s.preview = { url: `http://${host}`, port, pid, worktree, log };
    });
    try {
      await waitReady(readyUrl, pid, log);
    } catch (err) {
      await killGroup(pid).catch(() => {});
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
    const hostOk = await acceptsHost(readyUrl, host);
    return updateState(id, (s) => {
      if (!hostOk) s.preview!.url = `http://localhost:${port}`;
      s.status = "ready";
      const step = s.steps.find((x) => x.name === "preview")!;
      step.status = "done";
      step.endedAt = new Date().toISOString();
    });
  } finally {
    closeSync(fd);
  }
}

export async function stopPreview(id: string): Promise<void> {
  const { preview } = readState(id);
  if (preview && isAlive(preview.pid)) await killGroup(preview.pid);
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
