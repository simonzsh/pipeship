import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeline, listStates, pipelineDir, readState, setMode, setStep, updateState, upsertChunk } from "../src/state.ts";
import {
  DASHBOARD_PORT, deletePipeline, findRecipe, isAlive, mainService, normalizeRecipe, pickPorts, previewLines, resolveEnv,
  savedRecipePath, startOrder, startPreview, stopPipeline, type Service,
} from "../src/preview.ts";
import { DEFAULT_PORT, serve } from "../src/server.ts";
import {
  classifyPr, defaultRunner, DEFAULT_LIMITS, failStaleMerges, mergeStack, MergeError, startMerge, type MergeDeps, type PrView, type Runner,
} from "../src/merge.ts";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { detectSession, findT3Thread, type ReadProc } from "../src/session.ts";
import { groupByStatus } from "../src/dashboard/groups.ts";
import { t3ThreadLink } from "../src/dashboard/session.tsx";

const root = mkdtempSync(join(tmpdir(), "pipeship-test-"));
process.env.PIPESHIP_HOME = join(root, "home");
process.env.T3CODE_HOME = join(root, "t3"); // never read the real T3 Code database
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
  const { port } = state.preview!;
  expect(state.preview!.url).toBe(`http://localhost:${port}`);
  expect(port).toBeGreaterThanOrEqual(3000);
  expect(port).toBeLessThan(4000);
  expect(state.preview!.services).toEqual([
    { name: "app", kind: "front", port, url: `http://localhost:${port}`, pid: state.preview!.pid, log: join(pipelineDir(id), "preview-app.log") },
  ]);
  expect(previewLines(state.preview!)).toEqual([`http://localhost:${port}`]);
  expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe("SECRET=1");
  expect(await (await fetch(`http://localhost:${state.preview!.port}`)).text()).toBe("hello");

  const pid = state.preview!.pid!;
  const stopped = await stopPipeline(id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.stopRequested).toBe(true);
  expect(isAlive(pid)).toBe(false);

  // A stopped pipeline can start its test environment again.
  const again = await startPreview(id, worktree);
  expect(await (await fetch(again.preview!.url)).text()).toBe("hello");
  await stopPipeline(id);
  expect(isAlive(again.preview!.pid!)).toBe(false);
}, 30_000);

test("preview fails clearly when the server crashes", async () => {
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ start: "echo boom; exit 1" }));
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  await expect(startPreview(id, repo)).rejects.toThrow("boom");
  expect(readState(id).preview).toBeUndefined();
  expect(existsSync(join(pipelineDir(id), "preview-app.log"))).toBe(true);
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

test("delete removes the worktrees and files, keeps the branch, and protects uncommitted work", async () => {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  const wt = join(pipelineDir(id), "worktrees", "main");
  git(repo, "worktree", "add", "-q", "-b", "pipeship/test/main", wt);

  await expect(deletePipeline(id)).rejects.toThrow("stop the pipeline");
  updateState(id, (s) => {
    s.status = "ready";
  });
  writeFileSync(join(wt, "draft.ts"), "work in progress");
  await expect(deletePipeline(id)).rejects.toThrow("uncommitted changes");
  expect(existsSync(wt)).toBe(true);

  await deletePipeline(id, { force: true });
  expect(existsSync(pipelineDir(id))).toBe(false);
  expect(git(repo, "worktree", "list").stdout).not.toContain(wt);
  expect(git(repo, "branch", "--list", "pipeship/test/main").stdout).toContain("pipeship/test/main");
});

test("package.json and both plugin manifests declare the same version", () => {
  const version = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf8")).version;
  const expected = version("package.json");
  expect(version(".claude-plugin/plugin.json")).toBe(expected);
  expect(version(".codex-plugin/plugin.json")).toBe(expected);
});

test("ids have no date: refs, --name, then the first 3 words of the title", () => {
  const one = createPipeline({ repo, title: "t", source: "linear", links: [{ ref: "IDA-1" }] });
  expect(one.id).toBe("ida-1");
  const two = createPipeline({ repo, title: "t", source: "linear", links: [{ ref: "IDB-1" }, { ref: "IDB-2" }] });
  expect(two.id).toBe("idb-1-idb-2");
  expect(createPipeline({ repo, title: "Link sessions", name: "session-link", source: "text" }).id).toBe("session-link");
  expect(createPipeline({ repo, title: "t", name: "ignored-name", source: "linear", links: [{ ref: "IDC-1" }] }).id).toBe("idc-1");
  expect(createPipeline({ repo, title: "Link each pipeline to its agent", source: "text" }).id).toBe("link-each-pipeline");
  expect(createPipeline({ repo, title: "Créer un lien rapide", source: "text" }).id).toBe("creer-un-lien");
});

test("duplicate ids get -2 then -3", () => {
  const ids = [1, 2, 3].map(() => createPipeline({ repo, title: "t", name: "dup-name", source: "text" }).id);
  expect(ids).toEqual(["dup-name", "dup-name-2", "dup-name-3"]);
});

const CLAUDE_ID = "cb41411e-2eaf-4c0e-b494-97ea2a18163f";
const CODEX_ID = "01a135f6-c8ab-7312-975b-351fdc9c7173";

function fakeHomes() {
  const dir = mkdtempSync(join(root, "homes-"));
  const homes = { claude: join(dir, "claude"), codex: join(dir, "codex") };
  mkdirSync(join(homes.claude, "sessions"), { recursive: true });
  mkdirSync(homes.codex, { recursive: true });
  return homes;
}

function procs(chain: { argv0: string; comm?: string; exe?: string }[]): ReadProc {
  return (pid) => {
    const p = chain[pid - 100];
    return p && { ppid: pid + 1 === 100 + chain.length ? 1 : pid + 1, argv0: p.argv0, comm: p.comm ?? "x", exe: p.exe };
  };
}

test("detection finds the nearest claude ancestor", () => {
  const homes = fakeHomes();
  writeFileSync(join(homes.claude, "sessions", "1.json"), JSON.stringify({ pid: 1, sessionId: CLAUDE_ID, cwd: "/work/dir" }));
  const read = procs([{ argv0: "zsh" }, { argv0: "claude" }, { argv0: "t3" }]);
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID };
  expect(detectSession({ env, startPid: 100, readProc: read, homes, cwd: "/fallback" })).toEqual({ harness: "claude", id: CLAUDE_ID, cwd: "/work/dir" });
  expect(detectSession({ env, startPid: 100, readProc: read, homes: fakeHomes(), cwd: "/fallback" })?.cwd).toBe("/fallback");
});

test("a codex shell under a claude session counts as codex", () => {
  const homes = fakeHomes();
  const read = procs([{ argv0: "zsh" }, { argv0: "/x/bin/codex", comm: "codex" }, { argv0: "claude" }]);
  const both = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: CODEX_ID, CODEX_SESSION_ID: "01a135f8-b528-7c11-9204-49a8a1627a10" };
  expect(detectSession({ env: both, startPid: 100, readProc: read, homes, cwd: "/c" })).toEqual({ harness: "codex", id: CODEX_ID, cwd: "/c" });
  const only = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_SESSION_ID: "01a135f8-b528-7c11-9204-49a8a1627a10" };
  expect(detectSession({ env: only, startPid: 100, readProc: read, homes })?.id).toBe("01a135f8-b528-7c11-9204-49a8a1627a10");
});

test("env vars alone are not enough", () => {
  const homes = fakeHomes();
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID };
  const none = procs([{ argv0: "zsh" }, { argv0: "sshd" }]);
  expect(detectSession({ env, startPid: 100, readProc: none, homes })).toBeUndefined();
  const claude = procs([{ argv0: "zsh" }, { argv0: "claude" }]);
  expect(detectSession({ env: {}, startPid: 100, readProc: claude, homes })).toBeUndefined();
  expect(detectSession({ env: { CLAUDE_CODE_SESSION_ID: "../../etc" }, startPid: 100, readProc: claude, homes })).toBeUndefined();
});

test("claude is matched by CLAUDE_CODE_EXECPATH", () => {
  const homes = fakeHomes();
  const path = "/opt/x/2.1.296";
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CLAUDE_CODE_EXECPATH: path };
  const read = procs([{ argv0: "zsh" }, { argv0: path, comm: "2.1.296", exe: path }]);
  expect(detectSession({ env, startPid: 100, readProc: read, homes })?.harness).toBe("claude");
  expect(detectSession({ env: { ...env, CLAUDE_CODE_EXECPATH: "/usr/bin/node" }, startPid: 100, readProc: read, homes })).toBeUndefined();
});

test("pipelines record their session, and old state files without one still load", () => {
  const session = { harness: "codex" as const, id: CODEX_ID, cwd: "/w" };
  const withSession = createPipeline({ repo, title: "t", source: "text", session });
  expect(readState(withSession.id).session).toEqual(session);

  const plain = createPipeline({ repo, title: "t", source: "text" });
  expect("session" in readState(plain.id)).toBe(false);
  const path = join(pipelineDir(plain.id), "state.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  delete old.session;
  writeFileSync(path, JSON.stringify(old));
  expect(readState(plain.id).session).toBeUndefined();
});

function fakeT3Home(rows: { thread: string; provider: string; cursor: object; deleted?: boolean }[]) {
  const dir = mkdtempSync(join(root, "t3-"));
  mkdirSync(join(dir, "userdata"));
  writeFileSync(join(dir, "userdata", "environment-id"), "affd9b7d-69f6-438e-8932-c374ef17ed06\n");
  const db = new Database(join(dir, "userdata", "state.sqlite"));
  db.run("CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT)");
  db.run("CREATE TABLE projection_threads (thread_id TEXT, deleted_at TEXT)");
  for (const r of rows) {
    db.run("INSERT INTO provider_session_runtime VALUES (?, ?, ?)", [r.thread, r.provider, JSON.stringify(r.cursor)]);
    db.run("INSERT INTO projection_threads VALUES (?, ?)", [r.thread, r.deleted ? "2026-10-01" : null]);
  }
  db.close();
  return dir;
}

test("a session is matched to the T3 Code thread that runs it", () => {
  const t3 = fakeT3Home([
    { thread: "2b0c8b67-4a50-43db-ad6a-1ee58fc13c67", provider: "claudeAgent", cursor: { threadId: "2b0c8b67-4a50-43db-ad6a-1ee58fc13c67", resume: CLAUDE_ID } },
    { thread: "11111111-2222-4333-8444-555555555555", provider: "codex", cursor: { threadId: CODEX_ID } },
    { thread: "99999999-2222-4333-8444-555555555555", provider: "claudeAgent", cursor: { resume: "dddddddd-2eaf-4c0e-b494-97ea2a18163f" }, deleted: true },
  ]);
  const environmentId = "affd9b7d-69f6-438e-8932-c374ef17ed06";
  expect(findT3Thread({ harness: "claude", id: CLAUDE_ID, cwd: "/w" }, t3)).toEqual({ environmentId, threadId: "2b0c8b67-4a50-43db-ad6a-1ee58fc13c67" });
  expect(findT3Thread({ harness: "codex", id: CODEX_ID, cwd: "/w" }, t3)).toEqual({ environmentId, threadId: "11111111-2222-4333-8444-555555555555" });
  // The harness picks the cursor field: a claude id never matches a codex thread.
  expect(findT3Thread({ harness: "claude", id: CODEX_ID, cwd: "/w" }, t3)).toBeUndefined();
  expect(findT3Thread({ harness: "claude", id: "dddddddd-2eaf-4c0e-b494-97ea2a18163f", cwd: "/w" }, t3)).toBeUndefined();
  expect(findT3Thread({ harness: "claude", id: CLAUDE_ID, cwd: "/w" }, join(root, "no-t3"))).toBeUndefined();
  expect(t3ThreadLink({ environmentId, threadId: "2b0c8b67-4a50-43db-ad6a-1ee58fc13c67" })).toBe(
    "t3code://threads/affd9b7d-69f6-438e-8932-c374ef17ed06/2b0c8b67-4a50-43db-ad6a-1ee58fc13c67",
  );
});

const svc = (name: string, kind: string, extra: Partial<Service> = {}): Service => ({
  name, kind, start: "true", portEnv: "PORT", readyPath: "/", ready: "http", env: {}, ...extra,
});

test("a dashboard port constant matches the server", () => {
  expect(DASHBOARD_PORT).toBe(DEFAULT_PORT);
});

test("fronts take ports from 3000, other kinds from 4000", async () => {
  const ports = await pickPorts([svc("web", "front"), svc("api", "back"), svc("worker", "job"), svc("admin", "front")], async () => true);
  expect(ports).toEqual({ web: 3000, api: 4000, worker: 4001, admin: 3001 });
});

test("port picking skips 4400 and ports in use", async () => {
  const back = await pickPorts([svc("api", "back")], async (p) => p >= 4400);
  expect(back).toEqual({ api: 4401 });
  const front = await pickPorts([svc("web", "front")], async (p) => p !== 3000);
  expect(front).toEqual({ web: 3001 });
});

test("fixed ports are reserved and must be free", async () => {
  const services = [svc("db", "infra", { fixedPort: 4000, portEnv: undefined }), svc("api", "back")];
  expect(await pickPorts(services, async () => true)).toEqual({ db: 4000, api: 4001 });
  await expect(pickPorts(services, async (p) => p !== 4000)).rejects.toThrow("fixed port 4000 is already in use");
});

test("env templates resolve ports and leave other placeholders", () => {
  const env = { A: "http://localhost:${api.port}", B: "${HOME}", C: "${api.portx}" };
  expect(resolveEnv(env, { api: 4000 })).toEqual({ A: "http://localhost:4000", B: "${HOME}", C: "${api.portx}" });
});

test("start order is back and other kinds, then fronts; the main service is the first front", () => {
  const list = [svc("web", "front"), svc("api", "back"), svc("admin", "front"), svc("worker", "job")];
  expect(startOrder(list).map((s) => s.name)).toEqual(["api", "worker", "web", "admin"]);
  expect(mainService(list).name).toBe("web");
  expect(mainService([svc("api", "back"), svc("worker", "job")]).name).toBe("api");
});

test("recipe validation errors", () => {
  const bad = (recipe: object) => () => normalizeRecipe(recipe as never, "r.json");
  const ok = { name: "a", kind: "back", start: "x" };
  expect(bad({ start: "x", services: [ok] })).toThrow('r.json: use either "start" or "services", not both');
  expect(bad({})).toThrow('r.json: "start" or "services" is required');
  expect(bad({ services: [] })).toThrow('r.json: "services" must be a non-empty list');
  expect(bad({ services: [{ kind: "back", start: "x" }] })).toThrow('r.json: service #1 needs a "name"');
  expect(bad({ services: [{ ...ok, name: "a b" }] })).toThrow('service name "a b" may only use letters, digits, "-" and "_"');
  expect(bad({ services: [ok, ok] })).toThrow('duplicate service name "a"');
  expect(bad({ services: [{ name: "a", kind: "back" }] })).toThrow('service "a": "start" is required');
  expect(bad({ services: [{ name: "a", start: "x" }] })).toThrow('service "a": "kind" is required');
  expect(bad({ services: [{ ...ok, fixedPort: 70000 }] })).toThrow('service "a": "fixedPort" must be a port number');
  expect(bad({ services: [ok, { ...ok, name: "b", fixedPort: 5432 }, { ...ok, name: "c", fixedPort: 5432 }] })).toThrow(
    'service "c": fixed port 5432 is already used by "b"',
  );
  expect(bad({ services: [{ ...ok, env: [] }] })).toThrow('service "a": "env" must be an object');
  expect(bad({ services: [{ ...ok, env: "K=1" }] })).toThrow('service "a": "env" must be an object');
  expect(bad({ services: ["x"] })).toThrow("r.json: service #1 must be an object");
  expect(bad({ services: [{ ...ok, readyPath: "health" }] })).toThrow('service "a": "readyPath" must start with "/"');
  expect(bad({ start: "x", readyPath: "health" })).toThrow('r.json: "readyPath" must start with "/"');
  expect(bad({ services: [{ ...ok, ready: "udp" }] })).toThrow('service "a": "ready" must be "http" or "tcp"');
  expect(bad({ services: [{ ...ok, env: { K: 1 } }] })).toThrow('service "a": env "K" must be a string');
  expect(bad({ services: [{ ...ok, env: { K: "${nope.port}" } }] })).toThrow('env "K" refers to unknown service "nope"');
  expect(bad({ services: [{ ...ok, env: { K: "${a.port}" } }] })).toThrow('env "K" refers to its own port');

  expect(normalizeRecipe({ start: "bun dev" })).toEqual([
    { name: "app", kind: "front", start: "bun dev", portEnv: "PORT", readyPath: "/", ready: "http", env: {} },
  ]);
  expect(normalizeRecipe({ services: [{ ...ok, fixedPort: 5432 }] })[0]!.portEnv).toBeUndefined();
});

test("a multi-service recipe starts back ends first, wires ports, and stop kills every service", async () => {
  const api = `Bun.serve({ port: Number(process.env.API_PORT), fetch: () => new Response('api') })`;
  const web = `await fetch(process.env.API_URL); Bun.serve({ port: Number(process.env.WEB_PORT), fetch: () => new Response(process.env.API_URL) })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "web", kind: "front", start: `bun -e "${web}"`, portEnv: "WEB_PORT", env: { API_URL: "http://localhost:${api.port}" } },
        { name: "api", kind: "back", start: `bun -e "${api}"`, portEnv: "API_PORT" },
      ],
    }),
  );
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  const state = await startPreview(id, repo);
  const preview = state.preview!;
  const [first, second] = preview.services!;
  expect([first!.name, second!.name]).toEqual(["api", "web"]);
  expect(second!.port).toBeGreaterThanOrEqual(3000);
  expect(second!.port).toBeLessThan(4000);
  expect(first!.port).toBeGreaterThanOrEqual(4000);
  expect(first!.port).toBeLessThan(5000);
  expect(first!.port).not.toBe(4400);
  expect(preview.url).toBe(second!.url);
  expect(preview.pid).toBe(second!.pid);
  expect(await (await fetch(second!.url)).text()).toBe(first!.url);
  expect(existsSync(first!.log) && existsSync(second!.log)).toBe(true);
  expect(previewLines(preview)).toHaveLength(3);

  await stopPipeline(id);
  expect(isAlive(first!.pid!) || isAlive(second!.pid!)).toBe(false);
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

test("a failed service stops the services already started", async () => {
  const api = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('api') })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "api", kind: "back", start: `bun -e "${api}"` },
        { name: "web", kind: "front", start: "echo api=$API_URL; exit 1", env: { API_URL: "http://localhost:${api.port}" } },
      ],
    }),
  );
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  const error = await startPreview(id, repo).catch((e: Error) => e);
  expect((error as Error).message).toMatch(/service "web" exited.*api=http:\/\/localhost:\d+/s);
  const port = /api=http:\/\/localhost:(\d+)/.exec((error as Error).message)![1];
  await expect(fetch(`http://localhost:${port}`)).rejects.toThrow();
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

function fakePreview(id: string, pid: number | undefined, extra: object = {}) {
  updateState(id, (s) => {
    s.preview = { url: "http://localhost:3000", port: 3000, pid, worktree: repo, log: "x", ...extra };
  });
}

test("stop handles an old state without services", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  fakePreview(id, sleeper.pid);
  try {
    await stopPipeline(id);
    expect(isAlive(sleeper.pid)).toBe(false);
    expect(readState(id).preview).toBeUndefined();
  } finally {
    if (isAlive(sleeper.pid)) process.kill(sleeper.pid);
  }
}, 30_000);

test("a fixed-port recipe refuses a second live pipeline of the same repo", async () => {
  const sleeper = Bun.spawn(["sleep", "60"], { detached: true } as never);
  const a = createPipeline({ repo, title: "a", name: "fixed-a", source: "text" });
  const b = createPipeline({ repo, title: "b", name: "fixed-b", source: "text" });
  fakePreview(a.id, sleeper.pid);
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ services: [{ name: "db", kind: "infra", start: "sleep 60", fixedPort: 4999 }] }));
  try {
    await expect(startPreview(b.id, repo)).rejects.toThrow("live test environment");
  } finally {
    await stopPipeline(a.id);
    await stopPipeline(b.id);
    if (isAlive(sleeper.pid)) process.kill(sleeper.pid);
  }
}, 30_000);

test("pickPorts skips reserved ports, fixed ones included", async () => {
  expect(await pickPorts([svc("web", "front"), svc("api", "back")], async () => true, new Set([3000, 4000, 4001]))).toEqual({ web: 3001, api: 4002 });
  const db = svc("db", "infra", { fixedPort: 5432, portEnv: undefined });
  await expect(pickPorts([db], async () => true, new Set([5432]))).rejects.toThrow("fixed port 5432 is already in use");
});

test("a pipeline still starting blocks a fixed-port recipe", async () => {
  const a = createPipeline({ repo, title: "a", name: "starting-a", source: "text" });
  const b = createPipeline({ repo, title: "b", name: "starting-b", source: "text" });
  fakePreview(a.id, undefined, { services: [{ name: "db", kind: "infra", port: 4999, url: "http://localhost:4999", log: "x" }] });
  writeFileSync(join(repo, ".pipeship.json"), JSON.stringify({ services: [{ name: "db", kind: "infra", start: "sleep 60", fixedPort: 4998 }] }));
  await expect(startPreview(b.id, repo)).rejects.toThrow("live test environment");
});

test("a start avoids the ports another pipeline has planned", async () => {
  const a = createPipeline({ repo, title: "a", name: "reserve-a", source: "text" });
  const b = createPipeline({ repo, title: "b", name: "reserve-b", source: "text" });
  fakePreview(a.id, undefined, { port: 3000, services: [{ name: "app", kind: "front", port: 3000, url: "http://localhost:3000", log: "x" }] });
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({ start: `bun -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"` }),
  );
  try {
    const state = await startPreview(b.id, repo);
    expect(state.preview!.port).toBe(3001);
  } finally {
    await stopPipeline(b.id);
  }
}, 30_000);

test("a tcp service is ready once its port accepts connections", async () => {
  const db = `Bun.listen({ hostname: 'localhost', port: Number(process.env.DB_PORT), socket: { data() {} } }); setInterval(() => {}, 1e6)`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({ services: [{ name: "db", kind: "infra", start: `bun -e "${db}"`, portEnv: "DB_PORT", ready: "tcp", readyPath: "/ignored" }] }),
  );
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  try {
    const state = await startPreview(id, repo);
    expect(state.status).toBe("ready");
    expect(state.preview!.services![0]!.pid).toBeDefined();
  } finally {
    await stopPipeline(id);
  }
}, 30_000);

test("stop during a slow start leaves no service running", async () => {
  const api = `await Bun.sleep(2000); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('api') })`;
  writeFileSync(
    join(repo, ".pipeship.json"),
    JSON.stringify({
      services: [
        { name: "api", kind: "back", start: `bun -e "${api}"` },
        { name: "web", kind: "front", start: "sleep 60" },
      ],
    }),
  );
  const { id } = createPipeline({ repo, title: "t", source: "text" });
  const pending = startPreview(id, repo).then(() => undefined, (e: Error) => e);
  await Bun.sleep(500);
  const during = readState(id).preview!.services!;
  await stopPipeline(id);
  expect(await pending).toBeInstanceOf(Error);
  const after = readState(id);
  expect(after.preview).toBeUndefined();
  expect(after.status).toBe("stopped");
  // The front service is never spawned, and the back one is dead.
  expect(during.find((x) => x.name === "web")!.pid).toBeUndefined();
  expect(isAlive(during.find((x) => x.name === "api")!.pid!)).toBe(false);
  await Bun.sleep(300);
  expect(readState(id).preview).toBeUndefined();
}, 30_000);

test("a plain-text ticket has no source", () => {
  const plain = createPipeline({ repo, title: "Fix the footer" });
  expect(readState(plain.id).ticket).toEqual({ title: "Fix the footer", links: [] });
  const linear = createPipeline({ repo, title: "t", source: "linear", links: [{ ref: "ABC-9" }] });
  expect(readState(linear.id).ticket.source).toBe("linear");
});

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("new records the base branch, and leaves it unset on a detached HEAD", () => {
  const created = (name: string) => {
    const r = spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), "new", "--repo", repo, "--title", "t", "--name", name], {
      encoding: "utf8",
      env: process.env,
    });
    return readState(JSON.parse(r.stdout).id);
  };
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  expect(created("on-branch").base).toBe("main");
  sh(repo, "checkout", "-q", "--detach");
  expect(created("detached").base).toBeUndefined();
});

// Merge stack: real git (local bare remote, rebase and push really run) behind a fake gh.
const commitFile = (cwd: string, name: string, content: string, msg: string) => {
  writeFileSync(join(cwd, name), content);
  sh(cwd, "add", ".");
  sh(cwd, "commit", "-q", "-m", msg);
};

function makeStack(n: number, commits = 1) {
  const dir = mkdtempSync(join(root, "stack-"));
  const origin = join(dir, "origin.git");
  const clone = join(dir, "repo");
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, clone);
  commitFile(clone, "base.txt", "base\n", "initial");
  sh(clone, "push", "-q", "origin", "main");
  const worktrees: string[] = [];
  for (let i = 1; i <= n; i++) {
    sh(clone, "checkout", "-q", "-b", `c${i}`, i === 1 ? "main" : `c${i - 1}`);
    // Several commits per chunk edit the same line of the same file: replaying an old commit
    // on top of the squash is an add/add conflict, so a wrong old tip cannot go unnoticed.
    for (let k = 0; k < commits; k++) {
      commitFile(clone, `f${i}.txt`, `${"ab"[k] ?? "z"}${commits === 1 ? `f${i}` : ""}\n`, `f${i} step ${k}`);
    }
    sh(clone, "push", "-q", "origin", `c${i}`);
    worktrees.push(join(dir, `wt-${i}`));
  }
  sh(clone, "checkout", "-q", "main");
  worktrees.forEach((wt, i) => sh(clone, "worktree", "add", "-q", wt, `c${i + 1}`));
  const { id } = createPipeline({ repo: clone, title: "stack", base: "main" });
  worktrees.forEach((worktree, i) =>
    upsertChunk(id, { name: `c${i + 1}`, branch: `c${i + 1}`, worktree, pr: `https://github.com/o/r/pull/${i + 1}`, status: "pr" }),
  );
  return { id, dir, origin, clone, worktrees };
}

interface FakePr {
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
  head: string;
  checks: PrView["statusCheckRollup"];
  mergeable: PrView["mergeable"];
  reviewDecision: string;
  isDraft: boolean;
  view?: (count: number) => Partial<PrView>; // per-view override; count starts at 1
  viewFails?: boolean;
  views: number;
  body: string;
  bodyFails?: boolean;
}

function fakeGh(stack: ReturnType<typeof makeStack>, count: number) {
  const prs: Record<number, FakePr> = {};
  for (let i = 1; i <= count; i++) {
    prs[i] = { state: "OPEN", base: i === 1 ? "main" : `c${i - 1}`, head: `c${i}`, checks: [], mergeable: "MERGEABLE", reviewDecision: "", isDraft: false, views: 0, body: `PR ${i}` };
  }
  const calls: string[] = [];
  const squash: Record<number, string> = {};
  const scratch = join(stack.dir, "scratch");
  sh(stack.dir, "clone", "-q", stack.origin, scratch);
  const originSha = (ref: string) => sh(stack.origin, "rev-parse", ref);
  const ok = (stdout = ""): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: "" });
  const gate: { wait?: Promise<void> } = {};
  const refuse = { merge: false };
  const gitCalls: string[] = [];

  const gh: Runner = async (_cmd, args) => {
    if (args[0] === "pr" && args[1] === "view" && args[4] === "body") return ok(JSON.stringify({ body: prs[Number(args[2]!.split("/").pop())]!.body }));
    if (args[0] === "pr" && args[1] === "view") {
      await gate.wait;
      const n = Number(args[2]!.split("/").pop());
      const pr = prs[n]!;
      pr.views++;
      if (pr.viewFails) return { code: 1, stdout: "", stderr: "boom\n" };
      const view = {
        number: n, url: args[2], state: pr.state, baseRefName: pr.base, headRefName: pr.head, headRefOid: originSha(pr.head),
        isDraft: pr.isDraft, mergeable: pr.mergeable, mergeStateStatus: "CLEAN", reviewDecision: pr.reviewDecision,
        statusCheckRollup: pr.checks, ...pr.view?.(pr.views),
      };
      return ok(JSON.stringify(view));
    }
    if (args[0] === "api") {
      const n = Number(args[3]!.split("/").pop());
      if (args[5]!.startsWith("body=")) {
        calls.push(`patch ${n} body`);
        if (prs[n]!.bodyFails) return { code: 1, stdout: "", stderr: "HTTP 500\n" };
        prs[n]!.body = args[5]!.slice(5);
        return ok("{}");
      }
      const base = args[5]!.replace("base=", "");
      calls.push(`patch ${n} ${base}`);
      prs[n]!.base = base;
      return ok("{}");
    }
    if (args[0] === "pr" && args[1] === "merge") {
      const n = Number(args[2]!.split("/").pop());
      const kind = args.includes("--merge") ? "merge" : "squash";
      calls.push(kind === "merge" ? `merge ${n} --merge` : `merge ${n}`);
      const pr = prs[n]!;
      const want = args[args.indexOf("--match-head-commit") + 1];
      if (want !== originSha(pr.head)) return { code: 1, stdout: "", stderr: "head commit mismatch\n" };
      if (kind === "merge" && refuse.merge) return { code: 1, stdout: "", stderr: "Merge commits are not allowed on this repository.\n" };
      sh(scratch, "fetch", "-q", "origin");
      sh(scratch, "checkout", "-q", "-B", pr.base, `origin/${pr.base}`);
      if (kind === "merge") {
        sh(scratch, "merge", "--no-ff", "-q", "-m", `merge #${n}`, `origin/${pr.head}`);
      } else {
        sh(scratch, "merge", "--squash", `origin/${pr.head}`);
        sh(scratch, "commit", "-q", "-m", `squash #${n}`);
      }
      sh(scratch, "push", "-q", "origin", pr.base);
      squash[n] = originSha(pr.base);
      pr.state = "MERGED";
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}\n` };
  };
  let clock = 0;
  const deps: Partial<MergeDeps> = {
    run: (cmd, args, opts) => {
      if (cmd === "gh") return gh(cmd, args, opts);
      gitCalls.push(args.join(" "));
      return defaultRunner(cmd, args, opts);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    limits: DEFAULT_LIMITS,
  };
  return { prs, calls, squash, deps, gate, refuse, gitCalls };
}

const chunkStatuses = (id: string) => readState(id).chunks.map((c) => c.status);

const noWrites = (gh: ReturnType<typeof fakeGh>) => {
  // base mode must never rebase, push, fetch or retarget.
  expect(gh.gitCalls).toEqual([]);
  expect(gh.calls.filter((c) => c.startsWith("patch") && !c.endsWith(" body"))).toEqual([]);
};

test("base: one PR is squash-merged into main with a single gh call and no git writes", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  const before = sh(stack.origin, "rev-parse", "c1");
  await mergeStack(stack.id, gh.deps, "base");
  const s = readState(stack.id);
  expect(gh.calls).toEqual(["merge 1"]);
  noWrites(gh);
  expect(s.merge).toMatchObject({ status: "done", mode: "base", message: "merged #1 into main" });
  expect(chunkStatuses(stack.id)).toEqual(["merged"]);
  expect(sh(stack.origin, "ls-tree", "--name-only", "main").split("\n")).toEqual(["base.txt", "f1.txt"]);
  expect(sh(stack.origin, "rev-list", "--count", "main")).toBe("2");
  expect(sh(stack.origin, "rev-parse", "c1")).toBe(before);
});

test("base: a failing check stops the merge, and a new run merges once it passes", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.checks = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }];
  await mergeStack(stack.id, gh.deps, "base");
  expect(readState(stack.id).merge).toMatchObject({ status: "failed", current: "c1" });
  expect(readState(stack.id).merge?.error).toContain("lint");
  expect(gh.calls).toEqual([]);
  expect(sh(stack.origin, "rev-list", "--count", "main")).toBe("1");

  gh.prs[1]!.checks = [];
  await mergeStack(stack.id, gh.deps, "base");
  expect(readState(stack.id).merge?.status).toBe("done");
  expect(gh.calls).toEqual(["merge 1"]);
  noWrites(gh);
});

test("base: checks that stay pending stop the merge after 15 min", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.checks = [{ name: "ci", status: "IN_PROGRESS" }];
  await mergeStack(stack.id, gh.deps, "base");
  expect(readState(stack.id).merge?.error).toBe("checks still running on #1 after 15 min");
  expect(gh.calls).toEqual([]);
});

test("base: a PR that targets another branch than the pipeline base fails", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.base = "develop";
  await mergeStack(stack.id, gh.deps, "base");
  expect(readState(stack.id).merge?.error).toBe("PR #1 targets develop, not main: retarget it or combine first");
  expect(gh.calls).toEqual([]);
});

test("base: after a combine, the bottom PR is the only open one and merges into main", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  await mergeStack(stack.id, gh.deps, "combine");
  gh.gitCalls.length = 0;
  await startMerge(stack.id, gh.deps).done;
  expect(gh.calls).toEqual(["merge 2 --merge", "patch 1 body", "merge 1"]);
  expect(readState(stack.id).merge).toMatchObject({ status: "done", mode: "base", message: "merged #1 into main" });
  noWrites(gh);
  expect(sh(stack.origin, "ls-tree", "--name-only", "main").split("\n")).toEqual(["base.txt", "f1.txt", "f2.txt"]);
});

test("merge: waits until GitHub computes mergeable, and gives up after 2 min", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.view = (n) => (n <= 2 ? { mergeable: "UNKNOWN" } : {});
  await mergeStack(stack.id, gh.deps, "base");
  expect(readState(stack.id).merge?.status).toBe("done");

  const stuck = makeStack(1);
  const ghStuck = fakeGh(stuck, 1);
  ghStuck.prs[1]!.mergeable = "UNKNOWN";
  await mergeStack(stuck.id, ghStuck.deps, "base");
  expect(readState(stuck.id).merge?.error).toContain("after 2 min");
  expect(ghStuck.calls).toEqual([]);
});

test("merge: one job per pipeline, and nothing to merge is a 400", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  let release!: () => void;
  gh.gate.wait = new Promise((r) => (release = r));
  const { state, done } = startMerge(stack.id, gh.deps, "base");
  expect(state.merge?.status).toBe("running");
  expect(() => startMerge(stack.id, gh.deps, "base")).toThrow(MergeError);
  try {
    startMerge(stack.id, gh.deps, "base");
  } catch (err) {
    expect((err as MergeError).status).toBe(409);
  }
  release();
  await done;
  expect(readState(stack.id).merge?.status).toBe("done");
  try {
    startMerge(stack.id, gh.deps, "base");
    throw new Error("expected a 400");
  } catch (err) {
    expect((err as MergeError).status).toBe(400);
  }
  expect(() => startMerge("nope-nope")).toThrow("unknown pipeline");
  const none = createPipeline({ repo, title: "no pr" });
  expect(() => startMerge(none.id)).toThrow("no open PR");
});

test("merge: stale runs are failed unless their process is alive; delete waits for a running merge", async () => {
  const { id } = createPipeline({ repo, title: "stale" });
  const now = new Date().toISOString();
  updateState(id, (s) => {
    s.status = "stopped";
    s.merge = { status: "running", mode: "base", pid: 999_999, startedAt: now, updatedAt: now };
  });
  failStaleMerges(() => true);
  expect(readState(id).merge?.status).toBe("running");
  await expect(deletePipeline(id)).rejects.toThrow("wait for the merge to finish");
  failStaleMerges(() => false);
  expect(readState(id).merge).toMatchObject({ status: "failed" });
  expect(readState(id).merge?.error).toContain("interrupted");
  await deletePipeline(id);
});

test("classifyPr: failed checks beat pending ones, BLOCKED waits for pending checks", () => {
  const pr = (over: Partial<PrView>): PrView => ({
    number: 5, url: "u", state: "OPEN", baseRefName: "main", headRefName: "h", headRefOid: "o", isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [], ...over,
  });
  const failed = { name: "lint", status: "COMPLETED", conclusion: "FAILURE" };
  const running = { name: "ci", status: "IN_PROGRESS" };
  expect(classifyPr(pr({ statusCheckRollup: [running, failed] }))).toEqual({ kind: "blocked", reason: "check failed on #5: lint" });
  expect(classifyPr(pr({ mergeStateStatus: "BLOCKED", statusCheckRollup: [running] })).kind).toBe("wait");
  expect(classifyPr(pr({ mergeStateStatus: "BLOCKED" })).kind).toBe("blocked");
  expect(classifyPr(pr({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual({ kind: "blocked", reason: "changes requested on #5" });
  expect(classifyPr(pr({ statusCheckRollup: [{ context: "x", state: "PENDING" }] })).kind).toBe("wait");
  expect(classifyPr(pr({ statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "SKIPPED" }] })).kind).toBe("ready");
});

test("merge: a STALE check run is not a failure", () => {
  const v = { number: 1, url: "u", state: "OPEN", baseRefName: "main", headRefName: "h", headRefOid: "o", isDraft: false, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [{ name: "a", status: "COMPLETED", conclusion: "STALE" }] } as PrView;
  expect(classifyPr(v).kind).toBe("ready");
});

test("merge: a running merge is stale when its pid is dead or it stopped refreshing updatedAt", async () => {
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  const mark = (updatedAt: string) =>
    updateState(stack.id, (s) => {
      s.merge = { status: "running", mode: "base", pid: process.pid, startedAt: updatedAt, updatedAt };
    });
  mark(new Date().toISOString());
  failStaleMerges(() => true);
  expect(readState(stack.id).merge?.status).toBe("running");
  expect(() => startMerge(stack.id, gh.deps, "base")).toThrow("already running");

  mark(old);
  failStaleMerges(() => true);
  expect(readState(stack.id).merge?.status).toBe("failed");

  mark(old);
  await startMerge(stack.id, gh.deps, "base").done; // the pid is alive but silent: no 409
  expect(readState(stack.id).merge?.status).toBe("done");
});

test("merge: every poll of a long wait refreshes updatedAt", async () => {
  const stack = makeStack(1);
  const gh = fakeGh(stack, 1);
  gh.prs[1]!.view = (n) => (n < 5 ? { statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS" }] } : {});
  const seen: number[] = [];
  const sleep = async () => {
    seen.push(Date.parse(readState(stack.id).merge!.updatedAt));
    updateState(stack.id, (s) => {
      s.merge!.updatedAt = "2000-01-01T00:00:00.000Z";
    });
  };
  await mergeStack(stack.id, { ...gh.deps, sleep }, "base");
  expect(seen).toHaveLength(4);
  expect(Math.min(...seen)).toBeGreaterThan(Date.now() - 60_000);
});

// Combine mode: the same real git remote, but nothing may be rebased, force-pushed or merged into main.
const refs = (stack: ReturnType<typeof makeStack>) =>
  Object.fromEntries(["main", "c1", "c2", "c3"].map((b) => [b, sh(stack.origin, "rev-parse", b)])) as Record<"main" | "c1" | "c2" | "c3", string>;
const isAncestor = (stack: ReturnType<typeof makeStack>, a: string, b: string) => {
  try {
    sh(stack.origin, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};

test("combine: three PRs fold top-down into the bottom PR, and nothing else moves", async () => {
  const stack = makeStack(3);
  const gh = fakeGh(stack, 3);
  const before = refs(stack);
  await mergeStack(stack.id, gh.deps, "combine");
  const after = refs(stack);
  const s = readState(stack.id);
  expect(gh.calls).toEqual(["merge 3 --merge", "merge 2 --merge", "patch 1 body"]);
  expect(s.merge).toMatchObject({ status: "done", mode: "combine", message: "combined 3 PRs into #1" });
  expect(chunkStatuses(stack.id)).toEqual(["pr", "merged", "merged"]);
  // origin main is untouched; c1 holds every commit; c2 and c3 only moved forward (no force push).
  expect(after.main).toBe(before.main);
  expect(sh(stack.origin, "ls-tree", "--name-only", "c1").split("\n")).toEqual(["base.txt", "f1.txt", "f2.txt", "f3.txt"]);
  expect(isAncestor(stack, before.c1, after.c1) && isAncestor(stack, before.c2, after.c1) && isAncestor(stack, before.c3, after.c1)).toBe(true);
  expect(isAncestor(stack, before.c2, after.c2)).toBe(true);
  expect(after.c3).toBe(before.c3);
  // Only read-only ls-remote calls (the new tip of the branch below): a rebase or a push would show up here.
  expect(gh.gitCalls.every((g) => g.startsWith("ls-remote origin"))).toBe(true);
  expect(gh.prs[1]!.body).toContain("Combines #2, #3");
  expect(gh.prs[1]!.body).toContain("https://github.com/o/r/pull/2");
  expect(gh.prs[1]!.body).toContain("https://github.com/o/r/pull/3");
  expect(gh.prs[1]!.body.startsWith("PR 1")).toBe(true);
  expect([1, 2, 3].map((n) => gh.prs[n]!.base)).toEqual(["main", "c1", "c2"]);
});

test("combine: falls back to --squash once when merge commits are refused", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  gh.refuse.merge = true;
  await mergeStack(stack.id, gh.deps, "combine");
  expect(gh.calls).toEqual(["merge 2 --merge", "merge 2", "patch 1 body"]);
  expect(readState(stack.id).merge?.status).toBe("done");
  expect(sh(stack.origin, "ls-tree", "--name-only", "c1").split("\n")).toEqual(["base.txt", "f1.txt", "f2.txt"]);
});

test("combine: another merge failure does not fall back to --squash", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  const run = gh.deps.run!;
  gh.deps.run = async (cmd, args, opts) =>
    args[1] === "merge" ? { code: 1, stdout: "", stderr: "GraphQL: base branch was modified\n" } : run(cmd, args, opts);
  await mergeStack(stack.id, gh.deps, "combine");
  expect(readState(stack.id).merge).toMatchObject({ status: "failed", error: "gh pr merge #2 failed: GraphQL: base branch was modified" });
});

test("combine: waits for GitHub to show the new head of the PR below before merging it", async () => {
  const stack = makeStack(3);
  const gh = fakeGh(stack, 3);
  const oldC2 = sh(stack.origin, "rev-parse", "c2");
  // Views 1-2 are before the fold of #3; views 3-4 still show the old head; then the new head, checks pending once.
  gh.prs[2]!.view = (n) =>
    n <= 4 ? (n <= 2 ? {} : { headRefOid: oldC2 }) : n === 5 ? { statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS" }] } : {};
  await mergeStack(stack.id, gh.deps, "combine");
  expect(readState(stack.id).merge).toMatchObject({ status: "done", message: "combined 3 PRs into #1" });
  expect(gh.calls).toEqual(["merge 3 --merge", "merge 2 --merge", "patch 1 body"]);
  expect(gh.prs[2]!.views).toBeGreaterThanOrEqual(6);
  // The fake gh refuses a merge whose --match-head-commit is not the real tip, so the new sha was used.
});

test("combine: an exact URL match decides what is already listed, and other 'not allowed' errors do not squash", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  gh.prs[1]!.body = "see https://github.com/o/r/pull/22";
  await mergeStack(stack.id, gh.deps, "combine");
  expect(gh.calls).toEqual(["merge 2 --merge", "patch 1 body"]);
  expect(gh.prs[1]!.body).toContain("- https://github.com/o/r/pull/2\n");

  const other = makeStack(2);
  const gh2 = fakeGh(other, 2);
  const run = gh2.deps.run!;
  let merges = 0;
  gh2.deps.run = async (cmd, args, opts) =>
    args[1] === "merge" ? (merges++, { code: 1, stdout: "", stderr: "You are not allowed to merge this pull request\n" }) : run(cmd, args, opts);
  await mergeStack(other.id, gh2.deps, "combine");
  expect(readState(other.id).merge?.status).toBe("failed");
  expect(merges).toBe(1);
});

test("combine: one open PR is a 400, and a PR that targets the wrong branch fails", async () => {
  const stack = makeStack(1);
  try {
    startMerge(stack.id, fakeGh(stack, 1).deps, "combine");
    throw new Error("expected a 400");
  } catch (err) {
    expect((err as MergeError).status).toBe(400);
    expect((err as MergeError).message).toBe("only one open PR: use Merge");
  }
  const bad = makeStack(2);
  const gh = fakeGh(bad, 2);
  gh.prs[2]!.base = "main";
  await mergeStack(bad.id, gh.deps, "combine");
  expect(readState(bad.id).merge?.error).toBe("PR #2 targets main, not c1");
  expect(gh.calls).toEqual([]);
});

test("combine: a resume after a failing check on #2 skips #3, which is already merged", async () => {
  const stack = makeStack(3);
  const gh = fakeGh(stack, 3);
  gh.prs[2]!.checks = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }];
  await mergeStack(stack.id, gh.deps, "combine");
  expect(readState(stack.id).merge).toMatchObject({ status: "failed", current: "c2" });
  expect(gh.calls).toEqual(["merge 3 --merge"]);
  expect(chunkStatuses(stack.id)).toEqual(["pr", "pr", "merged"]);

  gh.prs[2]!.checks = [];
  const { done } = startMerge(stack.id, gh.deps, "combine");
  await done;
  expect(gh.calls).toEqual(["merge 3 --merge", "merge 2 --merge", "patch 1 body"]);
  expect(readState(stack.id).merge).toMatchObject({ status: "done", message: "combined 3 PRs into #1" });
  expect(gh.gitCalls.every((g) => g.startsWith("ls-remote origin"))).toBe(true);
});

test("combine: a failed description update keeps the merges and lists each PR once on resume", async () => {
  const stack = makeStack(2);
  const gh = fakeGh(stack, 2);
  gh.prs[1]!.bodyFails = true;
  await mergeStack(stack.id, gh.deps, "combine");
  expect(readState(stack.id).merge?.error).toBe("could not update the description of #1: HTTP 500. The PRs are combined; edit the description by hand.");
  expect(chunkStatuses(stack.id)).toEqual(["pr", "merged"]);

  gh.prs[1]!.bodyFails = false;
  await mergeStack(stack.id, gh.deps, "combine");
  await mergeStack(stack.id, gh.deps, "combine");
  expect(gh.calls).toEqual(["merge 2 --merge", "patch 1 body", "patch 1 body"]);
  expect(gh.prs[1]!.body.match(/pull\/2/g)).toHaveLength(1);
  expect(readState(stack.id).merge?.status).toBe("done");
});

test("merge mode: validation by open PR count, and an unknown mode is a 400", async () => {
  const one = makeStack(1);
  const two = makeStack(2);
  const err = (id: string, mode?: unknown) => {
    try {
      startMerge(id, {}, mode);
    } catch (e) {
      return [(e as MergeError).status, (e as MergeError).message];
    }
    throw new Error("expected a throw");
  };
  expect(err(two.id, "base")).toEqual([400, "combine the PRs first"]);
  expect(err(one.id, "combine")).toEqual([400, "only one open PR: use Merge"]);
  expect(err(one.id, "nope")).toEqual([400, "unknown merge mode"]);
  expect(err(two.id, "nope")).toEqual([400, "unknown merge mode"]);

  // Through the route: the 400s happen before any gh call.
  const server = await serve(0);
  try {
    const post = async (id: string, body: string) => {
      const res = await fetch(`http://localhost:${server.port}/api/pipelines/${id}/merge`, { method: "POST", body });
      return [res.status, ((await res.json()) as { error?: string }).error];
    };
    expect(await post(two.id, JSON.stringify({ mode: "base" }))).toEqual([400, "combine the PRs first"]);
    expect(await post(one.id, JSON.stringify({ mode: "combine" }))).toEqual([400, "only one open PR: use Merge"]);
    expect(await post(one.id, JSON.stringify({ mode: "x" }))).toEqual([400, "unknown merge mode"]);
  } finally {
    server.stop(true);
  }

  // No mode: one PR picks base, two PRs pick combine.
  const gh1 = fakeGh(one, 1);
  const a = startMerge(one.id, gh1.deps);
  expect(a.state.merge?.mode).toBe("base");
  await a.done;
  expect(gh1.calls).toEqual(["merge 1"]);
  const gh2 = fakeGh(two, 2);
  const b = startMerge(two.id, gh2.deps, undefined);
  expect(b.state.merge?.mode).toBe("combine");
  await b.done;
  expect(gh2.calls).toEqual(["merge 2 --merge", "patch 1 body"]);
});

test("the API adds test.md as testGuide without writing it to state.json", async () => {
  const withGuide = createPipeline({ repo, title: "Guide", source: "text" });
  const without = createPipeline({ repo, title: "No guide", source: "text" });
  const statePath = join(pipelineDir(withGuide.id), "state.json");
  const before = readFileSync(statePath, "utf8");
  writeFileSync(join(pipelineDir(withGuide.id), "test.md"), "# Test\n1. Open the page\n");

  const server = await serve(0);
  try {
    const list = (await (await fetch(`http://localhost:${server.port}/api/pipelines`)).json()) as { id: string; testGuide?: string }[];
    expect(list.find((p) => p.id === withGuide.id)?.testGuide).toBe("# Test\n1. Open the page\n");
    expect(list.find((p) => p.id === without.id)).not.toHaveProperty("testGuide");

    // The SSE stream carries it too.
    const res = await fetch(`http://localhost:${server.port}/api/events`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain('"testGuide":"# Test\\n1. Open the page\\n"');
  } finally {
    server.stop(true);
  }
  expect(readFileSync(statePath, "utf8")).toBe(before);
  expect(readState(withGuide.id)).not.toHaveProperty("testGuide");
});

test("setMode quick sets the mode and skips only pending quick steps; full only changes the mode", () => {
  const p = createPipeline({ repo, title: "Switch mode", source: "text" });
  const plan = () => readState(p.id).steps.find((s) => s.name === "plan")!.status;
  setMode(p.id, "quick");
  expect(readState(p.id).mode).toBe("quick");
  expect(plan()).toBe("skipped");
  setMode(p.id, "full");
  expect(readState(p.id).mode).toBe("full");
  expect(plan()).toBe("skipped");

  const running = createPipeline({ repo, title: "Plan running", source: "text" });
  setStep(running.id, "plan", "running");
  setMode(running.id, "quick");
  expect(readState(running.id).steps.find((s) => s.name === "plan")!.status).toBe("running");

  expect(() => setMode(p.id, "fast" as never)).toThrow("unknown mode: fast");
});

test("groupByStatus orders groups, hides empty ones and keeps the order inside a group", () => {
  const order = ["waiting_for_user", "ready", "running", "failed", "stopped"];
  const items = [
    { id: "a", status: "running" },
    { id: "b", status: "stopped" },
    { id: "c", status: "waiting_for_user" },
    { id: "d", status: "running" },
    { id: "e", status: "waiting_for_user" },
  ];
  const groups = groupByStatus(items, order);
  expect(groups.map((g) => g.status)).toEqual(["waiting_for_user", "running", "stopped"]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["c", "e"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["a", "d"]);
  expect(groupByStatus([], order)).toEqual([]);
});

test("groupByStatus puts an unknown status in the last group", () => {
  const groups = groupByStatus([{ status: "weird" }, { status: "ready" }, { status: "stopped" }], ["ready", "stopped"]);
  expect(groups.map((g) => [g.status, g.items.length])).toEqual([["ready", 1], ["stopped", 2]]);
});
