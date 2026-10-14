import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner, errorMessage, type Runner } from "./merge.ts";
import { harnessHomes, type Env } from "./session.ts";
import type { Harness } from "./state.ts";

const LATEST_URL = "https://raw.githubusercontent.com/simonzsh/shipflow/main/.claude-plugin/plugin.json";
const PLUGIN_KEY = "shipflow@shipflow";
const CACHE_MS = 600_000;

// What /api/update returns; harness is null for a copy no plugin manager installed.
export interface UpdateInfo { current: string; latest: string | null; available: boolean; harness: Harness | null }
interface UpdateDeps { fetch: typeof fetch; now: () => number; current: string; harness: Harness | null }

export class UpdateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// The plugin.json of a running copy cannot change: read it once.
let version: string | undefined;
export const currentVersion = () =>
  (version ??= JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url).pathname, "utf8")).version as string);

// Numeric x.y.z compare; a missing or non-numeric part counts as 0.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// One cached lookup per process: GitHub is asked at most once every 10 minutes, a failure is retried on the next call.
let cache: { latest: string; checkedAt: number } | undefined;
export const resetUpdateCache = () => void (cache = undefined);

export async function getUpdateInfo(deps: Partial<UpdateDeps> = {}): Promise<UpdateInfo> {
  const { fetch: doFetch = fetch, now = Date.now, current = currentVersion(), harness = currentHarness() } = deps;
  if (!cache || now() - cache.checkedAt >= CACHE_MS) {
    try {
      const res = await doFetch(LATEST_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const version = (await res.json()).version;
      if (typeof version !== "string") throw new Error("no version");
      cache = { latest: version, checkedAt: now() };
    } catch {
      return { current, latest: null, available: false, harness };
    }
  }
  return { current, latest: cache.latest, available: compareVersions(cache.latest, current) > 0, harness };
}

interface Installed { installPath: string; version: string }

// Which plugin manager installed the running copy; undefined for a git checkout or any other path.
export function detectHarness(root = dirname(dirname(new URL(import.meta.url).pathname)), env: Env = process.env): Harness | undefined {
  let real = root;
  try { real = realpathSync(root); } catch {}
  const homes = harnessHomes(env);
  return (["claude", "codex"] as const).find((h) => real.startsWith(join(homes[h], "plugins") + "/"));
}

// The running copy does not move: resolve its harness once, not on every request.
let detected: Harness | null | undefined;
export const currentHarness = (): Harness | null => (detected ??= detectHarness() ?? null);

async function readClaudeInstalled(_run: Runner, env: Env): Promise<Installed | undefined> {
  const file = join(harnessHomes(env).claude, "plugins", "installed_plugins.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const entry = (data.plugins ?? data)[PLUGIN_KEY]?.[0];
    return typeof entry?.installPath === "string" && entry.installPath ? { installPath: entry.installPath, version: String(entry.version ?? "") } : undefined;
  } catch {
    return undefined;
  }
}

// Codex lists installs without a path: it is rebuilt from the cache layout.
export async function readCodexInstalled(run: Runner, env: Env = process.env): Promise<Installed | undefined> {
  try {
    const res = await run("codex", ["plugin", "list", "--json"], { cwd: homedir(), timeoutMs: 30_000 });
    if (res.code !== 0) return undefined;
    const list: { pluginId?: string; name?: string; marketplaceName?: string; version?: string }[] = JSON.parse(res.stdout).installed ?? [];
    const e = list.find((p) => p.pluginId === PLUGIN_KEY);
    if (!e?.name || !e.marketplaceName || !e.version) return undefined;
    return { installPath: join(harnessHomes(env).codex, "plugins", "cache", e.marketplaceName, e.name, e.version), version: e.version };
  } catch {
    return undefined;
  }
}

interface Strategy {
  commands: [string, string[]][];
  read: (run: Runner, env: Env) => Promise<Installed | undefined>;
}

const strategies: Record<Harness, Strategy> = {
  claude: { commands: [["claude", ["plugin", "update", PLUGIN_KEY]]], read: readClaudeInstalled },
  codex: {
    commands: [["codex", ["plugin", "marketplace", "upgrade", "shipflow"]], ["codex", ["plugin", "add", PLUGIN_KEY]]],
    read: readCodexInstalled,
  },
};

export interface InstallDeps {
  run: Runner;
  env: Env;
  launcherExists: (path: string) => boolean;
  blocker: () => string | undefined; // why a restart is unsafe right now
}

type InstallResult = { restarting: true; launcher: string } | { restarting: false; message: string };

let installing = false;

// Runs the harness update commands; restarts only when the installed plugin really moved to a new dir or version.
export async function installUpdate(harness: Harness | null, deps: Partial<InstallDeps> = {}): Promise<InstallResult> {
  const { run = defaultRunner, env = process.env, launcherExists = existsSync, blocker = () => undefined } = deps;
  const busy = blocker();
  if (busy) throw new UpdateError(busy, 409);
  if (!harness) return { restarting: false, message: "This copy is not installed through a plugin manager (Claude Code or Codex): update it with git" };
  const strategy = strategies[harness];
  const read = () => strategy.read(run, env);
  if (installing) throw new UpdateError("An update is already running", 409);
  installing = true;
  try {
    const before = await read();
    for (const [cmd, args] of strategy.commands) {
      const name = `${cmd} ${args.slice(0, 2).join(" ")}`;
      let res;
      try {
        res = await run(cmd, args, { cwd: homedir(), timeoutMs: 120_000 });
      } catch (err) {
        throw new UpdateError(`${name} failed: ${errorMessage(err)}`, 500);
      }
      if (res.code !== 0) throw new UpdateError(`${name} failed: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`, 500);
    }
    const after = await read();
    if (!after) return { restarting: false, message: `The plugin is not installed through ${harness} yet: nothing to update` };
    if (after.installPath === before?.installPath && after.version === before?.version) {
      return { restarting: false, message: "Already up to date: the plugin did not change" };
    }
    const launcher = join(after.installPath, "scripts", "shipflow");
    if (!launcherExists(launcher)) return { restarting: false, message: `The new version has no launcher at ${launcher}` };
    // A start or merge may have begun while the update ran.
    const late = blocker();
    if (late) throw new UpdateError(`Updated, but not restarted: ${late}`, 409);
    return { restarting: true, launcher };
  } finally {
    installing = false;
  }
}
