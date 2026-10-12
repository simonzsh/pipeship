#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isAlive, killGroup, startPreview, stopPipeline } from "./preview.ts";
import { DEFAULT_PORT, isDashboardUp, serve } from "./server.ts";
import {
  STEPS, createPipeline, home, listStates, pipelineDir, readState, setStep, updateState, upsertChunk,
  type Chunk, type Mode, type Status, type StepName, type StepStatus,
} from "./state.ts";

const USAGE = `pipeship — state, test environments and dashboard for the /pipeship skill

  new --repo <path> --title <text> --source <name> [--ref <id>] [--url <url>] [--mode full|quick] [--skip a,b]
  get <id>                     print the state (JSON)
  list                         list pipelines
  step <id> <step> <status>    steps: ${STEPS.join(", ")}; status: pending, running, done, skipped, failed
  status <id> <status>         running, waiting_for_user, ready, failed, stopped
  chunk <id> <name> [--worktree p] [--branch b] [--status s] [--pr url]
  preview <id> <worktree>      start the test environment (reads .pipeship.json)
  stop <id>                    stop the pipeline and its test server
  dashboard [start|stop] [--port n]   start the dashboard in the background (default) or stop it
  serve [--port n]             run the dashboard in the foreground`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" }, title: { type: "string" }, source: { type: "string" },
    ref: { type: "string" }, url: { type: "string" }, mode: { type: "string" }, skip: { type: "string" },
    worktree: { type: "string" }, branch: { type: "string" }, status: { type: "string" }, pr: { type: "string" },
    port: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
const port = values.port ? Number(values.port) : DEFAULT_PORT;
const print = (data: unknown) => console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}\n\n${USAGE}`);
  return value;
}

async function startDashboard(): Promise<string> {
  const url = `http://localhost:${port}`;
  if (await isDashboardUp(port)) return url;
  mkdirSync(home(), { recursive: true });
  const out = openSync(join(home(), "dashboard.log"), "a");
  const child = spawn(process.execPath, [import.meta.path, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(join(home(), "dashboard.pid"), String(child.pid));
  for (let i = 0; i < 50; i++) {
    if (await isDashboardUp(port)) return url;
    await Bun.sleep(100);
  }
  throw new Error(`dashboard did not start, see ${join(home(), "dashboard.log")}`);
}

async function stopDashboard(): Promise<string> {
  const pidFile = join(home(), "dashboard.pid");
  if (!existsSync(pidFile)) return "dashboard not running";
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (isAlive(pid)) await killGroup(pid);
  rmSync(pidFile);
  return `dashboard stopped (pid ${pid})`;
}

async function main() {
  switch (command) {
    case "new": {
      const state = createPipeline({
        repo: resolve(need(values.repo, "--repo")),
        title: need(values.title, "--title"),
        source: need(values.source, "--source"),
        ref: values.ref,
        url: values.url,
        mode: (values.mode as Mode) ?? "full",
        skip: values.skip?.split(",").map((s) => s.trim()) as StepName[] | undefined,
      });
      return print({ id: state.id, dir: pipelineDir(state.id), steps: state.steps.map((s) => `${s.name}:${s.status}`) });
    }
    case "get":
      return print(readState(need(args[0], "<id>")));
    case "list":
      return print(listStates().map((s) => `${s.id}\t${s.status}\t${s.step}\t${s.ticket.title}`).join("\n") || "no pipelines");
    case "step":
      setStep(need(args[0], "<id>"), need(args[1], "<step>") as StepName, need(args[2], "<status>") as StepStatus);
      return print("ok");
    case "status":
      updateState(need(args[0], "<id>"), (s) => {
        s.status = need(args[1], "<status>") as Status;
      });
      return print("ok");
    case "chunk": {
      const chunk: Chunk = { name: need(args[1], "<name>") };
      if (values.worktree) chunk.worktree = resolve(values.worktree);
      if (values.branch) chunk.branch = values.branch;
      if (values.status) chunk.status = values.status;
      if (values.pr) chunk.pr = values.pr;
      upsertChunk(need(args[0], "<id>"), chunk);
      return print("ok");
    }
    case "preview": {
      const state = await startPreview(need(args[0], "<id>"), resolve(need(args[1], "<worktree>")));
      return print(state.preview!.url);
    }
    case "stop":
      await stopPipeline(need(args[0], "<id>"));
      return print("stopped");
    case "dashboard":
      return print(args[0] === "stop" ? await stopDashboard() : await startDashboard());
    case "serve":
      serve(port);
      return console.log(`pipeship dashboard on http://localhost:${port}`);
    default:
      print(USAGE);
      if (command && !values.help) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
