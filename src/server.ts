import tailwind from "bun-plugin-tailwind";
import { errorMessage, failStaleMerges, MergeError, startMerge } from "./merge.ts";
import { DiffError, pipelineDiff } from "./diff-git.ts";
import type { DiffErrorBody } from "./diff.ts";
import { listDashboardStates } from "./state.ts";
import { deletePipeline, stopPipeline } from "./preview.ts";

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

export async function serve(port = DEFAULT_PORT) {
  const assets = await buildDashboard();
  const server = Bun.serve({
    port,
    idleTimeout: 0, // keep SSE connections open
    routes: {
      ...assets,
      "/api/health": () => Response.json({ app: "pipeship" }),
      "/api/pipelines": () => Response.json(listDashboardStates()),
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
          const msg = errorMessage(err);
          const body: DiffErrorBody =
            err instanceof DiffError
              ? { error: msg, code: err.code }
              : { error: msg, code: msg.startsWith("unknown pipeline:") ? "not_found" : "git_failed" };
          const status = err instanceof DiffError ? err.status : body.code === "not_found" ? 404 : 500;
          return Response.json(body, { status });
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
              const data = JSON.stringify(listDashboardStates());
              if (data !== last) controller.enqueue(`data: ${data}\n\n`);
              last = data;
            };
            push();
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
  });
  failStaleMerges(); // after the port is open, so a slow state read cannot delay startup
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
