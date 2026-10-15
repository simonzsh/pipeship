import { archiveIfAllMerged } from "./preview.ts";
import { mergeRunning } from "./repos.ts";
import { defaultRunner, errorMessage, type Runner } from "./merge.ts";
import { CLOSED, home, listStates, markRepoMerged, MERGED, readState, withStateLock, writeState, type Chunk, type State } from "./state.ts";

export const SYNC_INTERVAL_MS = 60_000;
export const KICK_MIN_MS = 15_000; // throttle for the page-load trigger
export const GH_TIMEOUT_MS = 30_000; // a hung gh call counts as an error

export interface SyncDeps {
  run: Runner;
  log: (line: string) => void;
  timeoutMs: number;
  archive: (id: string) => Promise<unknown>;
  lastError: { value?: string }; // the previous pass's error, to log each error once
}

// Closed PRs stay polled: a reopened PR sends its chunk back to done.
export function polledChunks(s: Pick<State, "chunks">): Chunk[] {
  return s.chunks.filter((c) => c.pr && c.status !== MERGED);
}

export function syncedStatus(status: string | undefined, ghState: string): string | undefined {
  if (ghState === "MERGED") return MERGED;
  if (ghState === "CLOSED") return status === CLOSED ? undefined : CLOSED;
  if (ghState === "OPEN" && status === CLOSED) return "done";
  return undefined;
}

async function ghState(run: Runner, c: Chunk, timeoutMs: number): Promise<{ state: string }> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gh timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const args = ["pr", "view", c.pr!, "--json", "state,mergedAt"];
    const res = await Promise.race([run("gh", args, { cwd: c.repo ?? home(), timeoutMs }), timeout]);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `gh exited with ${res.code}`);
    const view = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null };
    const state = view.mergedAt || view.state === "MERGED" ? "MERGED" : view.state;
    if (state !== "MERGED" && state !== "OPEN" && state !== "CLOSED") throw new Error(`unexpected PR state ${String(view.state)}`);
    return { state };
  } finally {
    clearTimeout(timer);
  }
}

// Never throws: on any error the state stays as it is.
export async function syncPrStatuses(deps: Partial<SyncDeps> = {}): Promise<{ checked: number; changed: number; failed: number }> {
  const d: SyncDeps = {
    run: deps.run ?? defaultRunner,
    log: deps.log ?? ((l) => console.error(l)),
    timeoutMs: deps.timeoutMs ?? GH_TIMEOUT_MS,
    archive: deps.archive ?? archiveIfAllMerged,
    lastError: deps.lastError ?? {},
  };
  const total = { checked: 0, changed: 0, failed: 0 };
  let firstError: string | undefined;
  let ids: string[];
  try {
    ids = listStates().map((s) => s.id);
  } catch (err) {
    d.log(`pr sync: cannot read states: ${errorMessage(err)}`);
    return total;
  }
  for (const id of ids) {
    // Read again per pipeline: a merge may have started since the listing.
    let s: State;
    try {
      s = readState(id);
    } catch {
      continue;
    }
    // Skip only the repos that merge: the others still sync.
    const polled = polledChunks(s).filter((c) => !mergeRunning(s, c.repo!));
    const results: { name: string; pr: string; state: string }[] = [];
    for (const c of polled) {
      try {
        results.push({ name: c.name, pr: c.pr!, ...(await ghState(d.run, c, d.timeoutMs)) });
        total.checked++;
      } catch (err) {
        total.failed++;
        firstError ??= errorMessage(err);
      }
    }
    try {
      // Lock the read-modify-write: a chunk or merge may have changed while gh ran.
      const changes = withStateLock(id, () => {
        const x = readState(id);
        const lines: string[] = [];
        for (const r of results) {
          const c = x.chunks.find((k) => k.name === r.name);
          if (!c || c.pr !== r.pr || c.status === MERGED || mergeRunning(x, c.repo!)) continue; // a merge may have started on this repo
          const next = syncedStatus(c.status, r.state);
          if (!next) continue;
          c.status = next;
          lines.push(`pr sync: ${id}/${c.name} -> ${next}`);
        }
        // One PR per repo: its chunks without a PR follow the merged one. Run on every pass (idempotent)
        // so a chunk left `done` by old code or a crash between two writes still catches up.
        for (const { path: repo } of x.repos) if (!mergeRunning(x, repo)) for (const name of markRepoMerged(x, repo)) lines.push(`pr sync: ${id}/${name} -> ${MERGED}`);
        if (lines.length > 0) writeState(x);
        return lines;
      });
      if (!changes.length) continue;
      total.changed += changes.length;
      changes.forEach((l) => d.log(l));
      if (changes.some((l) => l.endsWith(`-> ${MERGED}`) || l.endsWith(`-> ${CLOSED}`))) await d.archive(id);
    } catch (err) {
      d.log(`pr sync: cannot update ${id}: ${errorMessage(err)}`);
    }
  }
  // Log an error once, not on every pass, so a missing gh does not fill the log.
  if (firstError && firstError !== d.lastError.value) d.log(`pr sync: ${total.failed} PR(s) not checked: ${firstError}`);
  d.lastError.value = firstError;
  return total;
}

export function startPrSync(opts: Partial<SyncDeps> & { intervalMs?: number; now?: () => number } = {}) {
  const { intervalMs = SYNC_INTERVAL_MS, now = Date.now, ...deps } = opts;
  let running: Promise<unknown> | undefined;
  const lastError: SyncDeps["lastError"] = {};
  let lastStart = -Infinity;
  const pass = () => {
    if (running) return;
    lastStart = now();
    running = syncPrStatuses({ ...deps, lastError })
      .catch((err) => (deps.log ?? console.error)(`pr sync: ${errorMessage(err)}`))
      .finally(() => {
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
