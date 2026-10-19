import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner, errorMessage, type Runner } from "./merge.ts";
import { harnessHomes, type Env } from "./session.ts";
import type { Harness } from "./state.ts";

const LATEST_URL = "https://raw.githubusercontent.com/simonzsh/pipeship/main/.claude-plugin/plugin.json";
const PLUGIN_KEY = "pipeship@pipeship";
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

const HARNESSES = ["claude", "codex"] as const satisfies readonly Harness[];

// Which plugin manager installed the running copy; undefined for a git checkout or any other path.
export function detectHarness(root = dirname(dirname(new URL(import.meta.url).pathname)), env: Env = process.env): Harness | undefined {
  let real = root;
  try { real = realpathSync(root); } catch {}
  const homes = harnessHomes(env);
  return HARNESSES.find((h) => real.startsWith(join(homes[h], "plugins") + "/"));
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
    commands: [["codex", ["plugin", "marketplace", "upgrade", "pipeship"]], ["codex", ["plugin", "add", PLUGIN_KEY]]],
    read: readCodexInstalled,
  },
};

export interface InstallDeps {
  run: Runner;
  env: Env;
  launcherExists: (path: string) => boolean;
  depsInstalled: (root: string) => boolean;
  blocker: () => string | undefined; // why a restart is unsafe right now
}

type InstallResult = { restarting: true; launcher: string; warning?: string } | { restarting: false; message: string };

let installing = false;

// `--omit=peer`: the tailwind plugin's `bun` peer would pull two Bun binaries (164 MB). Keep in sync with scripts/pipeship.
const INSTALL_DEPS: [string, string[]] = ["bun", ["install", "--frozen-lockfile", "--production", "--omit=peer"]];

async function updateHarness(h: Harness, run: Runner): Promise<void> {
  for (const [cmd, args] of strategies[h].commands) {
    const name = `${cmd} ${args.slice(0, 2).join(" ")}`;
    const res = await run(cmd, args, { cwd: homedir(), timeoutMs: 120_000 }).catch((err) => {
      throw new Error(`${name} failed: ${errorMessage(err)}`);
    });
    if (res.code !== 0) throw new Error(`${name} failed: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`);
  }
}

// One dashboard serves pipelines from both harnesses, so it updates every installed copy, not only its own.
// It restarts from the running copy when that one moved, else from another copy that is newer than the running one.
export async function installUpdate(harness: Harness | null, deps: Partial<InstallDeps> = {}): Promise<InstallResult> {
  const { run = defaultRunner, env = process.env, launcherExists = existsSync, depsInstalled = (root) => existsSync(join(root, "node_modules")), blocker = () => undefined } = deps;
  const busy = blocker();
  if (busy) throw new UpdateError(busy, 409);
  if (!harness) return { restarting: false, message: "This copy is not installed through a plugin manager (Claude Code or Codex): update it with git" };
  if (installing) throw new UpdateError("An update is already running", 409);
  installing = true;
  try {
    const copies: { h: Harness; before?: Installed; after?: Installed; error?: string }[] = await Promise.all(
      HARNESSES.map(async (h) => ({ h, before: await strategies[h].read(run, env) })),
    );
    // The running copy is always updated, even when its install cannot be read.
    const targets = copies.filter((c) => c.h === harness || c.before);
    // Harnesses are independent: update them in parallel, and one failure does not stop the other.
    await Promise.all(
      targets.map(async (c) => {
        try {
          await updateHarness(c.h, run);
          c.after = await strategies[c.h].read(run, env);
        } catch (err) {
          c.error = errorMessage(err);
        }
      }),
    );
    const errors = targets.flatMap((c) => (c.error ? [c.error] : []));
    const done = targets.filter((c) => !c.error);
    if (!done.length) throw new UpdateError(errors.join("; "), 500);
    const warning = errors.join("; ") || undefined;
    const note = warning ? ` (${warning})` : "";
    if (!done.some((c) => c.after)) return { restarting: false, message: `The plugin is not installed through ${harness} yet: nothing to update${note}` };
    const changed = done.flatMap((c) =>
      c.after && (c.after.installPath !== c.before?.installPath || c.after.version !== c.before?.version) ? [{ h: c.h, ...c.after }] : [],
    );
    const best =
      changed.find((c) => c.h === harness) ??
      changed.filter((c) => compareVersions(c.version, currentVersion()) > 0).sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!best) {
      const what = changed.length ? `Updated ${changed.map((c) => c.h).join(" and ")}: the running dashboard already has the latest version` : "Already up to date: the plugin did not change";
      return { restarting: false, message: what + note };
    }
    const launcher = join(best.installPath, "scripts", "pipeship");
    if (!launcherExists(launcher)) return { restarting: false, message: `The new version has no launcher at ${launcher}${note}` };
    // Install while the old dashboard still runs, so the downtime is only the build and bind.
    if (!depsInstalled(best.installPath)) {
      const [cmd, args] = INSTALL_DEPS;
      const res = await run(cmd, args, { cwd: best.installPath, timeoutMs: 120_000 }).catch((err) => ({ code: 1, stdout: "", stderr: errorMessage(err) }));
      if (res.code !== 0) return { restarting: false, message: `Updated, but installing the dependencies failed: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}${note}` };
    }
    // A start or merge may have begun while the update ran.
    const late = blocker();
    if (late) throw new UpdateError(`Updated, but not restarted: ${late}`, 409);
    return { restarting: true, launcher, warning };
  } finally {
    installing = false;
  }
}

// What `POST /api/update/install` returns.
export type InstallResponse = { restarting: true; from: string } | { restarting: false; message: string } | { error: string };

// `pipeship update` without a dashboard: update the installs; the next command runs the new copy.
export async function updateInPlace(install: () => Promise<InstallResult> = () => installUpdate(currentHarness())): Promise<string> {
  const result = await install();
  if (!result.restarting) return result.message;
  const note = result.warning ? ` (${result.warning})` : "";
  return `Updated: the next pipeship command runs the new version from ${dirname(dirname(result.launcher))}${note}`;
}
