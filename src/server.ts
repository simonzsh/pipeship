import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { errorMessage, failStaleMerges, isMergeRunning, MergeError, startMerge } from "./merge.ts";
import { DiffError, pipelineDiff } from "./diff-git.ts";
import type { DiffErrorBody } from "./diff.ts";
import { startPrSync } from "./pr-sync.ts";
import { home, listDashboardStates, type Harness } from "./state.ts";
import { currentHarness, currentVersion, getUpdateInfo, installUpdate, UpdateError, type InstallDeps } from "./update.ts";
import {
  anyPreviewStarting, archivePipeline, deletePipeline, isPreviewStarting, PreviewError, requestPreviewStart, stopPipeline, stopPreviewAndSettle,
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
  writeFileSync(join(home(), "dashboard.pid"), String(child.pid));
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
          if (restarting) return Response.json({ restarting: true, from: currentVersion() });
          try {
            const blocker = () =>
              anyPreviewStarting() ? "A test environment is starting: wait for it, then update" :
              isMergeRunning() ? "A merge is running: wait for it, then update" : undefined;
            const result = await installUpdate(opts.harness !== undefined ? opts.harness : currentHarness(), { blocker, ...opts.update });
            if (!result.restarting) return Response.json({ restarting: false, message: result.message });
            restarting = true;
            setTimeout(() => handoff(result.launcher), 300); // let the response go out first
            return Response.json({ restarting: true, from: currentVersion() });
          } catch (err) {
            const status = err instanceof UpdateError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
      },
      "/api/pipelines": () => Response.json(listDashboardStates(isPreviewStarting)),
      "/api/pipelines/:id/diff": async (req) => {
        // Ids come from slug(): reject anything else before it reaches the filesystem.
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(req.params.id)) {
          return Response.json({ error: `unknown pipeline: ${req.params.id}`, code: "not_found" } satisfies DiffErrorBody, { status: 404 });
        }
        const q = new URL(req.url).searchParams;
        try {
          return Response.json(await pipelineDiff(req.params.id, q.get("repo"), q.get("chunk")), {
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
            const body = (await req.json().catch(() => null)) as { mode?: unknown; repo?: unknown } | null;
            return Response.json(startMerge(req.params.id, {}, body?.mode, body?.repo).state, { status: 202 });
          } catch (err) {
            const status = err instanceof MergeError ? err.status : 500;
            return Response.json({ error: errorMessage(err) }, { status });
          }
        },
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
              const data = JSON.stringify(listDashboardStates(isPreviewStarting));
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

export async function isDashboardUp(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return (await res.json()).app === "pipeship";
  } catch {
    return false;
  }
}
