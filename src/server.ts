import tailwind from "bun-plugin-tailwind";
import { listStates } from "./state.ts";
import { stopPipeline } from "./preview.ts";

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
  return Bun.serve({
    port,
    idleTimeout: 0, // keep SSE connections open
    routes: {
      ...assets,
      "/api/health": () => Response.json({ app: "pipeship" }),
      "/api/pipelines": () => Response.json(listStates()),
      "/api/pipelines/:id/stop": {
        POST: async (req) => {
          try {
            return Response.json(await stopPipeline(req.params.id));
          } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
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
              const data = JSON.stringify(listStates());
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
}

export async function isDashboardUp(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return (await res.json()).app === "pipeship";
  } catch {
    return false;
  }
}
