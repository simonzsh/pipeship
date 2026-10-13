import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Harness, Session } from "./state.ts";

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

// Only the cwd is read: the entries also hold a peer token and a socket path.
function claudeCwd(claudeHome: string, id: string): string | undefined {
  const dir = join(claudeHome, "sessions");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {}
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (raw?.sessionId === id && typeof raw.cwd === "string") return raw.cwd;
    } catch {}
  }
  return undefined;
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
  const found = harness === "claude" ? claudeCwd(homes.claude, id) : codexCwd(homes.codex, id);
  return { harness, id, cwd: found ?? opts.cwd ?? process.cwd() };
}
