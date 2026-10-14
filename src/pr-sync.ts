import { defaultRunner, errorMessage, type Runner } from "./merge.ts";
import { CLOSED, home, listStates, MERGED, updateState, type Chunk, type State } from "./state.ts";

export const SYNC_INTERVAL_MS = 60_000;
export const KICK_MIN_MS = 15_000; // throttle for the page-load trigger
export const GH_TIMEOUT_MS = 30_000; // a hung gh call counts as an error

export interface SyncDeps {
  run: Runner;
  log: (line: string) => void;
  timeoutMs: number;
}

// Closed PRs stay polled: a reopened PR sends its chunk back to done.
export function polledChunks(s: Pick<State, "chunks">): Chunk[] {
  return s.chunks.filter((c) => c.pr && c.status !== MERGED);
}

export function syncedStatus(status: string | undefined, ghState: string): string | undefined {
  if (ghState === MERGED.toUpperCase()) return MERGED;
  if (ghState === "CLOSED") return status === CLOSED ? undefined : CLOSED;
  if (ghState === "OPEN" && status === CLOSED) return "done";
  return undefined;
}

async function ghState(run: Runner, c: Chunk, timeoutMs: number): Promise<string> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gh timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const args = ["pr", "view", c.pr!, "--json", "state,mergedAt"];
    const res = await Promise.race([run("gh", args, { cwd: c.repo ?? home() }), timeout]);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `gh exited with ${res.code}`);
    const view = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null };
    if (view.mergedAt || view.state === "MERGED") return "MERGED";
    if (view.state === "OPEN" || view.state === "CLOSED") return view.state;
    throw new Error(`unexpected PR state ${String(view.state)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Never throws: on any error the state stays as it is.
export async function syncPrStatuses(deps: Partial<SyncDeps> = {}): Promise<{ checked: number; changed: number; failed: number }> {
  const d: SyncDeps = { run: defaultRunner, log: (l) => console.error(l), timeoutMs: GH_TIMEOUT_MS, ...deps };
  const total = { checked: 0, changed: 0, failed: 0 };
  let firstError: string | undefined;
  let states: State[];
  try {
    states = listStates();
  } catch (err) {
    d.log(`pr sync: cannot read states: ${errorMessage(err)}`);
    return total;
  }
  for (const s of states) {
    if (s.merge?.status === "running") continue;
    const results: { name: string; pr: string; state: string }[] = [];
    for (const c of polledChunks(s)) {
      try {
        results.push({ name: c.name, pr: c.pr!, state: await ghState(d.run, c, d.timeoutMs) });
        total.checked++;
      } catch (err) {
        total.failed++;
        firstError ??= errorMessage(err);
      }
    }
    const changes: string[] = [];
    try {
      // Re-read inside one sync update: a chunk or merge may have changed while gh ran.
      updateState(s.id, (x) => {
        if (x.merge?.status === "running") return;
        for (const r of results) {
          const c = x.chunks.find((k) => k.name === r.name);
          if (!c || c.pr !== r.pr || c.status === MERGED) continue;
          const next = syncedStatus(c.status, r.state);
          if (!next) continue;
          c.status = next;
          changes.push(`pr sync: ${s.id}/${c.name} -> ${next}`);
        }
        if (!changes.length) throw NO_CHANGE;
      });
    } catch (err) {
      if (err !== NO_CHANGE) {
        total.failed++;
        firstError ??= errorMessage(err);
      }
    }
    total.changed += changes.length;
    changes.forEach((l) => d.log(l));
  }
  if (total.failed) d.log(`pr sync: ${total.failed} PR(s) not checked: ${firstError}`);
  return total;
}

// Thrown inside updateState's callback to skip the write when nothing changed.
const NO_CHANGE = Symbol("no change");

export function startPrSync(opts: Partial<SyncDeps> & { intervalMs?: number; now?: () => number } = {}) {
  const { intervalMs = SYNC_INTERVAL_MS, now = Date.now, ...deps } = opts;
  let running: Promise<unknown> | undefined;
  let lastStart = -Infinity;
  const pass = () => {
    if (running) return;
    lastStart = now();
    running = syncPrStatuses(deps).finally(() => {
      running = undefined;
    });
  };
  pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref();
  return {
    kick: () => {
      if (!running && now() - lastStart >= KICK_MIN_MS) pass();
    },
    stop: () => clearInterval(timer),
    idle: async () => {
      await running;
    },
  };
}
