import { listStates } from "./state.ts";
import { stopPipeline } from "./preview.ts";

export const DEFAULT_PORT = 4400;
const html = Bun.file(new URL("./dashboard.html", import.meta.url));

export function serve(port = DEFAULT_PORT) {
  return Bun.serve({
    port,
    idleTimeout: 0, // keep SSE connections open
    routes: {
      "/": () => new Response(html),
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
