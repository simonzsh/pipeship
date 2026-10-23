import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { errorMessage, failStaleMerges, forceMerge, isMergeRunning, MergeError, startMerge } from "./merge.ts";
import { DiffError, pipelineDiff } from "./diff-git.ts";
import type { DiffErrorBody } from "./diff.ts";
import { startPrSync } from "./pr-sync.ts";
import { home, listDashboardStates, type Harness } from "./state.ts";
import { currentHarness, currentVersion, getUpdateInfo, installUpdate, UpdateError, type InstallDeps, type InstallResponse } from "./update.ts";
import { shouldReload } from "./dashboard/update-info.ts";
import {
  anyPreviewStarting, archivePipeline, deletePipeline, getDeleteRun, isDeleteRunning, isDeleting, isPreviewStarting, PreviewError, processStart, requestPreviewStart, startDeleteArchived, stopPipeline, stopPreviewAndSettle,
  unarchivePipeline,
} from "./preview.ts";

export const DEFAULT_PORT = 4400;

// Build the React page in memory at startup: no build step, and it works from any cwd
// (Bun's HTML imports would read the Tailwind plugin from the cwd's bunfig.toml).
async function buildDashboard(): Promise<Record<string, Response>> {
  const result = await Bun.build({
    entrypoints: [new URL("./dashboard/index.html", import.meta.url).pathname],
    plugins: [tailwind],
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new AggregateError(result.logs, "dashboard build failed");
  const routes: Record<string, Response> = {};
  for (const output of result.outputs) {
    const path = output.path.replace(/^\./, "");
    routes[path === "/index.html" ? "/" : path] = new Response(await output.arrayBuffer(), {
      headers: { "Content-Type": output.type },
    });
  }
  return routes;
}

// After an update the old server may still hold the port for a moment: retry the bind.
async function listen(options: Parameters<typeof Bun.serve>[0] & { port: number }, retryMs: number) {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      return Bun.serve(options);
    } catch (err) {
      if ((err as { code?: string }).code !== "EADDRINUSE" || Date.now() >= deadline) throw err;
      await Bun.sleep(200);
    }
  }
}

// Detached so the dashboard outlives its parent; runs from ~/.pipeship, not the caller's project.
export function spawnDashboard(command: string, args: string[]) {
  mkdirSync(home(), { recursive: true });
  const out = openSync(join(home(), "dashboard.log"), "a");
  const child = spawn(command, args, { cwd: home(), detached: true, stdio: ["ignore", out, out] });
  child.unref();
  writeFileSync(join(home(), "dashboard.pid"), `${child.pid}\n${processStart(child.pid!) ?? ""}`);
}

// Line 1 is the pid, line 2 (optional) its start time. A one-line file from an old version still reads.
export function readDashboardPid(): { pid: number; startedAt?: string } | undefined {
  const file = join(home(), "dashboard.pid");
  if (!existsSync(file)) return undefined;
  const [pid, startedAt] = readFileSync(file, "utf8").split("\n");
  return { pid: Number(pid), ...(startedAt?.trim() && { startedAt: startedAt.trim() }) };
}

export interface ServeOptions { prSync?: boolean; retryMs?: number; harness?: Harness | null; update?: Partial<InstallDeps> }

export async function serve(port = DEFAULT_PORT, opts: ServeOptions = {}) {
  let sync: ReturnType<typeof startPrSync> | undefined;
  const assets = await buildDashboard();
  let restarting = false;
  // Start the new version's launcher first (it retries the bind), then free the port and leave. Previews are detached.
  const handoff = (launcher: string) => {
    try {
      spawnDashboard(launcher, ["serve", "--port", String(server.port)]);
    } catch (err) {
      restarting = false;
      console.error(`restart failed: ${errorMessage(err)}`);
      return;
    }
    server.stop(true);
    sync?.stop();
    process.exit(0);
  };
  const server = await listen({
    port,
    idleTimeout: 0, // keep SSE connections open
    routes: {
      ...assets,
      "/api/health": () => Response.json({ app: "pipeship", version: currentVersion() }),
      "/api/update": async () => Response.json(await getUpdateInfo({ harness: opts.harness }), { headers: { "Cache-Control": "no-store" } }),
      "/api/update/install": {
        POST: async () => {
          const reply = (body: InstallResponse, status = 200) => Response.json(body, { status });
          if (restarting) return reply({ restarting: true, from: currentVersion() });
          try {
            const blocker = () =>
              anyPreviewStarting() ? "A preview is starting: wait for it, then update" :
              isMergeRunning() ? "A merge is running: wait for it, then update" :
              isDeleteRunning() ? "A delete is running: wait for it, then update" : undefined;
            const result = await installUpdate(opts.harness !== undefined ? opts.harness : currentHarness(), { blocker, ...opts.update });
            if (!result.restarting) return reply({ restarting: false, message: result.message });
            restarting = true;
            if (result.warning) console.error(`update: ${result.warning}`);
            setTimeout(() => handoff(result.launcher), 300); // let the response go out first
            return reply({ restarting: true, from: currentVersion() });
          } catch (err) {
            return reply({ error: errorMessage(err) }, err instanceof UpdateError ? err.status : 500);
          }
        },
      },
      "/api/pipelines": () => Response.json(listDashboardStates(isPreviewStarting, isDeleting)),
      "/api/pipelines/:id/diff": async (req) => {
        // Ids come from slug(): reject anything else before it reaches the filesystem.
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(req.params.id)) {
          return Response.json({ error: `unknown pipeline: ${req.params.id}`, code: "not_found" } satisfies DiffErrorBody, { status: 404 });
        }
        const q = new URL(req.url).searchParams;
        try {
          return Response.json(await pipelineDiff(req.params.id, q.get("repo"), q.get("chunk"), undefined, { fetch: q.get("fetch") === "1" }), {
            headers: { "Cache-Control": "no-store" },
          });
        } catch (err) {
          const body: DiffErrorBody =
            err instanceof DiffError ? { error: err.message, code: err.code } : { error: errorMessage(err), code: "git_failed" };
          return Response.json(body, { status: err instanceof DiffError ? err.status : 500 });
        }
      },
      "/api/pipelines/:id/stop": {
        POST: async (req) => {
          try {
            return Response.json(await stopPipeline(req.params.id));
          } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
          }
        },
      },
      "/api/pipelines/:id/archive": {
        POST: async (req) => {
          try {
            return Response.json(await archivePipeline(req.params.id));
          } catch (err) {
            const status = err instanceof PreviewError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
      },
      "/api/pipelines/:id/unarchive": {
        POST: async (req) => {
          try {
            return Response.json(await unarchivePipeline(req.params.id));
          } catch (err) {
            const status = err instanceof PreviewError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
      },
      "/api/pipelines/:id/preview/start": {
        POST: async (req) => {
          try {
            return Response.json(requestPreviewStart(req.params.id).state, { status: 202 });
          } catch (err) {
            const status = err instanceof PreviewError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
      },
      // Unlike /stop, only the test servers go: a ready pipeline becomes done.
      "/api/pipelines/:id/preview/stop": {
        POST: async (req) => {
          try {
            return Response.json(await stopPreviewAndSettle(req.params.id));
          } catch (err) {
            return Response.json({ error: errorMessage(err) }, { status: 500 });
          }
        },
      },
      "/api/pipelines/:id/merge": {
        POST: async (req) => {
          try {
            const body = (await req.json().catch(() => null)) as { mode?: unknown; repo?: unknown; deleteBranches?: unknown; force?: unknown } | null;
            // An old tab would send a {mode} field without deleteBranches: reject, never reinterpret.
            if (body?.mode !== undefined) throw new MergeError("mode is no longer supported: reload the dashboard", 400);
            if (body?.force !== undefined && typeof body.force !== "boolean") throw new MergeError("force must be a boolean", 400);
            if (body?.force === true) return Response.json(forceMerge(req.params.id, body?.repo), { status: 202 });
            return Response.json(startMerge(req.params.id, {}, body?.repo, body?.deleteBranches).state, { status: 202 });
          } catch (err) {
            const status = err instanceof MergeError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
      },
      "/api/pipelines/delete-archived": {
        POST: async () => {
          try {
            return Response.json(startDeleteArchived().run, { status: 202 });
          } catch (err) {
            const status = err instanceof PreviewError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
        GET: async () =>
          Response.json(getDeleteRun() ?? { running: false, total: 0, deleted: [], failed: [], startedAt: "" }, { headers: { "Cache-Control": "no-store" } }),
      },
      "/api/pipelines/:id/delete": {
        POST: async (req) => {
          try {
            await deletePipeline(req.params.id);
            return Response.json({ deleted: req.params.id });
          } catch (err) {
            return Response.json({ error: errorMessage(err) }, { status: 500 });
          }
        },
      },
      // Polling the files is simpler and more reliable than fs.watch across platforms.
      "/api/events": (req) => {
        let last = "";
        let timer: Timer;
        const stream = new ReadableStream({
          start(controller) {
            const push = () => {
              const data = JSON.stringify(listDashboardStates(isPreviewStarting, isDeleting));
              if (data !== last) controller.enqueue(`data: ${data}\n\n`);
              last = data;
            };
            push();
            sync?.kick(); // page load: refresh PR statuses without waiting for the next tick
            timer = setInterval(push, 1000);
            req.signal.addEventListener("abort", () => clearInterval(timer));
          },
          cancel: () => clearInterval(timer),
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  }, opts.retryMs ?? 0);
  failStaleMerges(); // after the port is open, so a slow state read cannot delay startup
  sync = opts.prSync ? startPrSync() : undefined; // after failStaleMerges: a dead merge must not hide its pipeline
  return server;
}

// The version of the pipeship dashboard on this port, or undefined when none answers.
export async function dashboardVersion(port = DEFAULT_PORT, doFetch: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await doFetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { app?: string; version?: string };
    return body.app === "pipeship" ? (body.version ?? "") : undefined;
  } catch {
    return undefined;
  }
}

export const isDashboardUp = async (port = DEFAULT_PORT) => (await dashboardVersion(port)) !== undefined;

// `pipeship update` with a dashboard: it owns the blockers and restarts itself, so ask it and wait for the new version.
export async function requestDashboardUpdate(port: number, deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; waitMs?: number } = {}): Promise<string> {
  const { fetch: doFetch = fetch, sleep = Bun.sleep, waitMs = 30_000 } = deps;
  const base = `http://localhost:${port}`;
  const res = await doFetch(`${base}/api/update/install`, { method: "POST" });
  const body = (await res.json()) as InstallResponse;
  if ("error" in body) throw new Error(body.error);
  if (!body.restarting) return body.message;
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    await sleep(500);
    const version = await dashboardVersion(port, doFetch);
    if (shouldReload(body.from, version)) return `Updated from ${body.from} to ${version}: the dashboard restarted on ${base}`;
  }
  throw new Error(`Updated, but the dashboard did not come back on ${base} within ${waitMs / 1000}s: see ${join(home(), "dashboard.log")}`);
}
