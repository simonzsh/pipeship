import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeline, listStates, readState, setStep, upsertChunk } from "../src/state.ts";
import { findRecipe, isAlive, savedRecipePath, startPreview, stopPipeline } from "../src/preview.ts";

const root = mkdtempSync(join(tmpdir(), "pipeship-test-"));
process.env.PIPESHIP_HOME = join(root, "home");
afterAll(() => rmSync(root, { recursive: true, force: true }));

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(root, "repo-"));
});

test("quick mode and --skip mark steps as skipped", () => {
  const quick = createPipeline({ repo, title: "Add date filter", source: "text", mode: "quick" });
  expect(quick.steps.find((s) => s.name === "plan")!.status).toBe("skipped");

  const custom = createPipeline({ repo, title: "x", source: "linear", links: [{ ref: "ABC-1" }], skip: ["questions", "stack"] });
  expect(custom.steps.filter((s) => s.status === "skipped").map((s) => s.name)).toEqual(["questions", "stack"]);
});

test("ids are unique for the same ticket", () => {
  const a = createPipeline({ repo, title: "t", source: "linear", links: [{ ref: "ABC-2" }] });
  const b = createPipeline({ repo, title: "t", source: "linear", links: [{ ref: "ABC-2" }] });
  expect(a.id).not.toBe(b.id);
  expect(listStates().map((s) => s.id)).toContain(b.id);
});

test("steps and chunks update the state", () => {
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  setStep(id, "questions", "running");
  upsertChunk(id, { name: "api", branch: "feat/api" });
  upsertChunk(id, { name: "api", pr: "https://example.com/pr/1" });
  const state = readState(id);
  expect(state.step).toBe("questions");
  expect(state.chunks).toEqual([{ name: "api", branch: "feat/api", pr: "https://example.com/pr/1" }]);
  expect(() => setStep(id, "nope" as never, "done")).toThrow("unknown step");
});

test("the pipeline is ready once every step is done or skipped", () => {
  const { id } = createPipeline({ repo, title: "t", source: "text", skip: ["preview"] });
  for (const name of ["map", "questions", "plan", "implement", "review"] as const) setStep(id, name, "done");
  expect(readState(id).status).toBe("running");
  setStep(id, "stack", "done");
  expect(readState(id).status).toBe("ready");
});

test("a failed pipeline stays failed when its last step ends", () => {
  const { id } = createPipeline({ repo, title: "t", source: "text", mode: "quick" });
  setStep(id, "review", "failed");
  for (const name of ["map", "questions", "implement", "review", "stack", "preview"] as const) setStep(id, name, "done");
  expect(readState(id).status).toBe("failed");
});

test("preview starts the app, copies local files, and stop kills it", async () => {
  writeFileSync(join(repo, ".env.local"), "SECRET=1");
  const worktree = mkdtempSync(join(root, "wt-"));
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      start: `bun -e "Bun.serve({ port: Number(process.env.APP_PORT), fetch: () => new Response('hello') })"`,
      portEnv: "APP_PORT",
      copyFiles: [".env.local"],
    }),
  );
  const { id } = createPipeline({ repo, title: "Preview test", source: "text", links: [{ ref: "DEMO-7" }] });

  const state = await startPreview(id, worktree);
  expect(state.status).toBe("ready");
  expect(state.preview!.url).toBe(`http://demo-7.localhost:${state.preview!.port}`);
  expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe("SECRET=1");
  expect(await (await fetch(`http://localhost:${state.preview!.port}`)).text()).toBe("hello");

  const pid = state.preview!.pid;
  const stopped = await stopPipeline(id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.stopRequested).toBe(true);
  expect(isAlive(pid)).toBe(false);
}, 30_000);

test("preview fails clearly when the server crashes", async () => {
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ start: "echo boom; exit 1" }));
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  await expect(startPreview(id, repo)).rejects.toThrow("boom");
  expect(readState(id).preview).toBeUndefined();
  expect(existsSync(join(process.env.PIPESHIP_HOME!, "pipelines", id, "preview.log"))).toBe(true);
}, 30_000);

test("a draft recipe is saved for the repo only when the app starts", async () => {
  const draft = join(root, "draft.json");
  writeFileSync(draft, JSON.stringify({ start: "exit 1" }));
  const first = createPipeline({ repo, title: "t", source: "text" });
  await expect(startPreview(first.id, repo, draft)).rejects.toThrow();
  expect(existsSync(savedRecipePath(repo))).toBe(false);

  writeFileSync(draft, JSON.stringify({ start: `bun -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` }));
  await startPreview(first.id, repo, draft);
  await stopPipeline(first.id);
  expect(findRecipe(repo)).toBe(savedRecipePath(repo));

  // The next pipeline in the same repo reuses the saved recipe without a draft.
  const second = createPipeline({ repo, title: "t", source: "text" });
  const state = await startPreview(second.id, repo);
  expect(state.status).toBe("ready");
  await stopPipeline(second.id);
}, 30_000);

test("the URL falls back to localhost when the app rejects the ticket host", async () => {
  const strict = `Bun.serve({ port: Number(process.env.PORT), fetch: (r) => r.headers.get('host')?.startsWith('localhost') ? new Response('ok') : new Response('blocked', { status: 403 }) })`;
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ start: `bun -e "${strict}"` }));
  const { id } = createPipeline({ repo, title: "t", source: "text", links: [{ ref: "HOST-1" }] });
  const state = await startPreview(id, repo);
  expect(state.preview!.url).toBe(`http://localhost:${state.preview!.port}`);
  await stopPipeline(id);
}, 30_000);

test("a pipeline keeps one link per ticket, and old state files are upgraded", () => {
  const { id } = createPipeline({
    repo, title: "t", source: "linear",
    links: [{ ref: "ABC-3", url: "https://example.com/ABC-3" }, { ref: "ABC-4", url: "https://example.com/ABC-4" }],
  });
  expect(id).toEndWith("abc-3-abc-4");
  expect(readState(id).ticket.links.map((l) => l.ref)).toEqual(["ABC-3", "ABC-4"]);

  const path = join(process.env.PIPESHIP_HOME!, "pipelines", id, "state.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  old.ticket = { source: "linear", title: "t", ref: "ABC-3,ABC-4", url: "https://example.com/ABC-3" };
  writeFileSync(path, JSON.stringify(old));
  expect(readState(id).ticket.links).toEqual([{ ref: "ABC-3", url: "https://example.com/ABC-3" }, { ref: "ABC-4" }]);
});
