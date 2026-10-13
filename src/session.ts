import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Harness, PipelineView, Session, SessionState, State } from "./state.ts";

export type Env = Record<string, string | undefined>;
export interface Homes { claude: string; codex: string }
export interface ProcInfo { ppid: number; argv0: string; comm: string; exe?: string }
export type ReadProc = (pid: number) => ProcInfo | undefined;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linux = process.platform === "linux";

export function harnessHomes(env: Env = process.env): Homes {
  return { claude: env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), codex: env.CODEX_HOME ?? join(homedir(), ".codex") };
}

// comm may contain spaces and parentheses: split on the last ")".
function statFields(pid: number): { comm: string; rest: string[] } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) return undefined;
    return { comm: stat.slice(open + 1, close), rest: stat.slice(close + 1).trim().split(" ") };
  } catch {
    return undefined;
  }
}

export function readProc(pid: number): ProcInfo | undefined {
  if (!linux) {
    const ps = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = ps.status === 0 ? ps.stdout.trim().match(/^(\d+)\s+(.+)$/) : null;
    return m ? { ppid: Number(m[1]), argv0: m[2].trim(), comm: m[2].trim() } : undefined;
  }
  const stat = statFields(pid);
  if (!stat) return undefined;
  let argv0 = "";
  try {
    argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
  } catch {}
  let exe: string | undefined;
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch {}
  return { ppid: Number(stat.rest[1]), argv0, comm: stat.comm, exe };
}

export function procStart(pid: number): string | undefined {
  if (!linux) return undefined;
  return statFields(pid)?.rest[19];
}

interface RegistryEntry { pid: number; sessionId: string; procStart?: unknown; status?: string; cwd?: string }

// Keeps only the fields we need: the entries also hold a peer token and a socket path.
function registry(claudeHome: string): RegistryEntry[] {
  const dir = join(claudeHome, "sessions");
  const entries: RegistryEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {}
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (typeof raw?.pid === "number" && typeof raw?.sessionId === "string") {
        entries.push({ pid: raw.pid, sessionId: raw.sessionId, procStart: raw.procStart, status: raw.status, cwd: raw.cwd });
      }
    } catch {}
  }
  return entries;
}

function codexCwd(codexHome: string, id: string): string | undefined {
  const path = join(codexHome, "state_5.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("SELECT cwd FROM threads WHERE id = ?").get(id) as { cwd?: string } | null;
      return row?.cwd ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function classify(info: ProcInfo, env: Env): Harness | undefined {
  const name = basename(info.argv0);
  const execPath = env.CLAUDE_CODE_EXECPATH;
  const execMatch =
    !!execPath && !["node", "bun"].includes(basename(execPath)) && (execPath === info.exe || execPath === info.argv0);
  if (name === "claude" || info.comm === "claude" || execMatch) return "claude";
  if (name === "codex" || info.comm === "codex" || (info.exe && basename(info.exe) === "codex")) return "codex";
  return undefined;
}

// Walk the ancestry: env vars leak into nested agents, so only the nearest harness process says which one runs us.
export function detectSession(opts: { env?: Env; startPid?: number; readProc?: ReadProc; homes?: Homes; cwd?: string } = {}): Session | undefined {
  const env = opts.env ?? process.env;
  const read = opts.readProc ?? readProc;
  const homes = opts.homes ?? harnessHomes(env);
  let pid = opts.startPid ?? process.ppid;
  let harness: Harness | undefined;
  for (let hop = 0; hop < 32 && pid >= 1 && !harness; hop++) {
    const info = read(pid);
    if (!info) break;
    harness = classify(info, env);
    pid = info.ppid;
  }
  if (!harness) return undefined;
  const id = harness === "claude" ? env.CLAUDE_CODE_SESSION_ID : (env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID);
  if (!id || !ID_RE.test(id)) return undefined;
  const found =
    harness === "claude" ? registry(homes.claude).find((e) => e.sessionId === id)?.cwd : codexCwd(homes.codex, id);
  return { harness, id, cwd: found ?? opts.cwd ?? process.cwd() };
}

interface SessionDeps {
  isAlive?: (pid: number) => boolean;
  procStart?: (pid: number) => string | undefined;
  lockHeld?: (path: string) => boolean;
  registry?: RegistryEntry[];
}

export function sessionState(
  session: Session,
  homes: Homes,
  deps: SessionDeps = {},
): SessionState {
  const { id } = session;
  if (!ID_RE.test(id)) return { status: "unknown" };
  try {
    return session.harness === "claude" ? claudeState(id, homes.claude, deps) : codexState(id, homes.codex, deps);
  } catch {
    return { status: "unknown" };
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claudeState(id: string, home: string, deps: SessionDeps): SessionState {
  const alive = deps.isAlive ?? defaultAlive;
  const start = deps.procStart ?? procStart;
  const live = (deps.registry ?? registry(home)).find(
    (e) => e.sessionId === id && alive(e.pid) && (e.procStart == null || String(e.procStart) === start(e.pid)),
  );
  if (live) return live.status === "busy" || live.status === "idle" ? { status: "active", activity: live.status } : { status: "active" };
  const projects = join(home, "projects");
  const found = existsSync(projects) && readdirSync(projects).some((d) => existsSync(join(projects, d, `${id}.jsonl`)));
  return { status: found ? "stopped" : "deleted" };
}

function codexState(id: string, home: string, deps: SessionDeps): SessionState {
  const held = deps.lockHeld ?? lockHeld;
  const lock = join(home, "thread-writer-locks", `${id}.lock`);
  if (existsSync(lock) && held(lock)) return { status: "loaded" };
  const dbPath = join(home, "state_5.sqlite");
  if (existsSync(dbPath)) {
    // Read-only, not immutable=1 (unsafe while Codex writes). Opening may create -wal/-shm when Codex is idle: harmless.
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT archived FROM threads WHERE id = ?").get(id) as { archived: number } | null;
      if (row) return { status: row.archived === 1 ? "archived" : "stopped" };
    } finally {
      db.close();
    }
  }
  for (const sub of ["sessions", "archived_sessions"]) {
    const dir = join(home, sub);
    if (!existsSync(dir)) continue;
    for (const _ of new Bun.Glob(`**/rollout-*-${id}.jsonl`).scanSync({ cwd: dir })) return { status: "stopped" };
  }
  return { status: "deleted" };
}

// Reads /proc/locks instead of taking the lock, so we never disturb the holder.
export function lockHeld(path: string): boolean {
  if (!linux) return true;
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
    const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
    const re = /^\d+:\s+(?:->\s+)?\S+\s+\S+\s+\S+\s+-?\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/i;
    return readFileSync("/proc/locks", "utf8").split("\n").some((line) => {
      const m = line.match(re);
      return !!m && parseInt(m[1], 16) === major && parseInt(m[2], 16) === minor && BigInt(m[3]) === ino;
    });
  } catch (e) {
    // A vanished lock file is not held; an unreadable /proc/locks errs toward "loaded".
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const LIVE_TTL_MS = 3000;
const TERMINAL_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: SessionState }>();

export function withSessionState(states: State[], opts: { homes?: Homes; now?: number } = {}): PipelineView[] {
  const homes = opts.homes ?? harnessHomes();
  const now = opts.now ?? Date.now();
  let entries: RegistryEntry[] | undefined; // read once per call, only if a Claude session needs it
  return states.map((s) => {
    if (!s.session) return s;
    const key = `${s.session.harness}:${s.session.id}`;
    let hit = cache.get(key);
    const terminal = hit?.value.status === "deleted" || hit?.value.status === "archived";
    if (!hit || now - hit.at > (terminal ? TERMINAL_TTL_MS : LIVE_TTL_MS)) {
      if (s.session.harness === "claude") entries ??= registry(homes.claude);
      hit = { at: now, value: sessionState(s.session, homes, { registry: entries }) };
      cache.set(key, hit);
    }
    return { ...s, sessionState: hit.value };
  });
}
