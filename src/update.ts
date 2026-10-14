import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner, errorMessage, type Runner } from "./merge.ts";

export const LATEST_URL = "https://raw.githubusercontent.com/simonzsh/pipeship/main/.claude-plugin/plugin.json";
export const PLUGIN_KEY = "pipeship@pipeship";
export const CACHE_MS = 3_600_000;

export interface UpdateInfo { current: string; latest: string | null; available: boolean; checkedAt?: number }
export interface UpdateDeps { fetch: typeof fetch; now: () => number; current: string }

export class UpdateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const readVersion = (path: string): string => JSON.parse(readFileSync(path, "utf8")).version;
export const currentVersion = () => readVersion(new URL("../.claude-plugin/plugin.json", import.meta.url).pathname);

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

// One cached lookup per process: GitHub is asked at most once an hour, a failure is retried on the next call.
let cache: { latest: string; checkedAt: number } | undefined;
export const resetUpdateCache = () => void (cache = undefined);

export async function getUpdateInfo(deps: Partial<UpdateDeps> = {}): Promise<UpdateInfo> {
  const { fetch: doFetch = fetch, now = Date.now, current = currentVersion() } = deps;
  if (!cache || now() - cache.checkedAt >= CACHE_MS) {
    try {
      const res = await doFetch(LATEST_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const version = (await res.json()).version;
      if (typeof version !== "string") throw new Error("no version");
      cache = { latest: version, checkedAt: now() };
    } catch {
      return { current, latest: null, available: false };
    }
  }
  return { current, latest: cache.latest, available: compareVersions(cache.latest, current) > 0, checkedAt: cache.checkedAt };
}

export interface Installed { installPath: string; version: string }
export type Harness = "claude" | "codex";

const claudeDir = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexDir = (env: NodeJS.ProcessEnv) => env.CODEX_HOME ?? join(homedir(), ".codex");

// Which plugin manager installed the running copy; undefined for a git checkout or any other path.
export function detectHarness(
  root = dirname(dirname(new URL(import.meta.url).pathname)),
  env: NodeJS.ProcessEnv = process.env,
): Harness | undefined {
  let real = root;
  try { real = realpathSync(root); } catch {}
  const inside = (dir: string, segment: string) => real.startsWith(join(dir, "plugins") + "/") || real.includes(segment);
  if (inside(claudeDir(env), "/.claude/plugins/")) return "claude";
  if (inside(codexDir(env), "/.codex/plugins/")) return "codex";
  return undefined;
}

export function readInstalled(env: NodeJS.ProcessEnv = process.env): Installed | undefined {
  const file = join(claudeDir(env), "plugins", "installed_plugins.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const entry = (data.plugins ?? data)[PLUGIN_KEY]?.[0];
    return typeof entry?.installPath === "string" && entry.installPath ? { installPath: entry.installPath, version: String(entry.version ?? "") } : undefined;
  } catch {
    return undefined;
  }
}

// Codex lists installs without a path: it is rebuilt from the cache layout.
export async function readCodexInstalled(run: Runner, env: NodeJS.ProcessEnv = process.env): Promise<Installed | undefined> {
  try {
    const res = await run("codex", ["plugin", "list", "--json"], { cwd: homedir(), timeoutMs: 30_000 });
    if (res.code !== 0) return undefined;
    const list: { pluginId?: string; name?: string; marketplaceName?: string; version?: string }[] = JSON.parse(res.stdout).installed ?? [];
    const e = list.find((p) => p.pluginId === PLUGIN_KEY);
    if (!e?.name || !e.marketplaceName || !e.version) return undefined;
    return { installPath: join(codexDir(env), "plugins", "cache", e.marketplaceName, e.name, e.version), version: e.version };
  } catch {
    return undefined;
  }
}

export interface Strategy {
  label: string;
  commands: [string, string[]][];
  read: (run: Runner) => Installed | undefined | Promise<Installed | undefined>;
}

export const strategies: Record<Harness, Strategy> = {
  claude: { label: "Claude Code", commands: [["claude", ["plugin", "update", PLUGIN_KEY]]], read: () => readInstalled() },
  codex: {
    label: "Codex",
    commands: [["codex", ["plugin", "marketplace", "upgrade", "pipeship"]], ["codex", ["plugin", "add", PLUGIN_KEY]]],
    read: (run) => readCodexInstalled(run),
  },
};

export interface InstallDeps {
  run: Runner;
  harness: Harness | undefined; // injectable; defaults to detectHarness()
  readInstalled: () => Installed | undefined | Promise<Installed | undefined>;
  launcherExists: (path: string) => boolean;
  blocker: () => string | undefined; // why a restart is unsafe right now
}

export type InstallResult = { restarting: true; launcher: string } | { restarting: false; message: string };

let installing = false;

// Runs the harness update commands; restarts only when the installed plugin really moved to a new dir or version.
export async function installUpdate(deps: Partial<InstallDeps> = {}): Promise<InstallResult> {
  const { run = defaultRunner, launcherExists = existsSync, blocker = () => undefined } = deps;
  const harness = "harness" in deps ? deps.harness : detectHarness();
  const busy = blocker();
  if (busy) throw new UpdateError(busy, 409);
  if (!harness) return { restarting: false, message: "This copy is not installed through a plugin manager (Claude Code or Codex): update it with git" };
  const strategy = strategies[harness];
  const read = deps.readInstalled ?? (() => strategy.read(run));
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
    if (!after) return { restarting: false, message: `The plugin is not installed through ${strategy.label} yet: nothing to update` };
    if (after.installPath === before?.installPath && after.version === before?.version) {
      return { restarting: false, message: "Already up to date: the plugin did not change" };
    }
    const launcher = join(after.installPath, "scripts", "pipeship");
    if (!launcherExists(launcher)) return { restarting: false, message: `The new version has no launcher at ${launcher}` };
    // A start or merge may have begun while the update ran.
    const late = blocker();
    if (late) throw new UpdateError(`Updated, but not restarted: ${late}`, 409);
    return { restarting: true, launcher };
  } finally {
    installing = false;
  }
}
