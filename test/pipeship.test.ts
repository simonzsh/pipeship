import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeline, listStates, pipelineDir, readState, setStep, updateState, upsertChunk } from "../src/state.ts";
import { deletePipeline, findRecipe, isAlive, savedRecipePath, startPreview, stopPipeline } from "../src/preview.ts";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { detectSession, lockHeld, procStart, sessionState, withSessionState, type ReadProc } from "../src/session.ts";

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

test.skipIf(process.platform !== "linux")("a claude session is active only while its registry entry matches a live process", () => {
  const homes = fakeHomes();
  const entry = (start: unknown) =>
    writeFileSync(join(homes.claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, procStart: start, status: "busy", cwd: "/w" }));
  writeFileSync(join(homes.claude, "sessions", `${process.pid}.abc.key`), "not read");
  const session = { harness: "claude" as const, id: CLAUDE_ID, cwd: "/w" };

  entry(procStart(process.pid));
  expect(sessionState(session, homes)).toEqual({ status: "active", activity: "busy" });

  entry("1");
  mkdirSync(join(homes.claude, "projects", "-x"), { recursive: true });
  writeFileSync(join(homes.claude, "projects", "-x", `${CLAUDE_ID}.jsonl`), "");
  expect(sessionState(session, homes)).toEqual({ status: "stopped" });

  entry(undefined);
  expect(sessionState(session, homes)).toEqual({ status: "active", activity: "busy" });

  entry(procStart(process.pid));
  expect(sessionState(session, homes, { isAlive: () => false })).toEqual({ status: "stopped" });

  rmSync(join(homes.claude, "projects"), { recursive: true });
  expect(sessionState(session, homes, { isAlive: () => false })).toEqual({ status: "deleted" });
  expect(sessionState({ ...session, id: "../../etc" }, homes)).toEqual({ status: "unknown" });
});

test("codex states come from the lock, the threads table and the rollouts", async () => {
  const homes = fakeHomes();
  const other = "01a135f8-b528-7c11-9204-49a8a1627a10";
  const db = new Database(join(homes.codex, "state_5.sqlite"));
  db.run("CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, archived INTEGER)");
  db.run("INSERT INTO threads VALUES (?, '/w', 0)", [CODEX_ID]);
  db.run("INSERT INTO threads VALUES (?, '/w', 1)", [other]);
  db.close();
  const at = (id: string) => sessionState({ harness: "codex", id, cwd: "/w" }, homes);
  expect(at(CODEX_ID)).toEqual({ status: "stopped" });
  expect(at(other)).toEqual({ status: "archived" });

  const orphan = "01a135f9-0000-7000-8000-000000000001";
  expect(at(orphan)).toEqual({ status: "deleted" });
  mkdirSync(join(homes.codex, "sessions", "2026", "10", "13"), { recursive: true });
  writeFileSync(join(homes.codex, "sessions", "2026", "10", "13", `rollout-x-${orphan}.jsonl`), "");
  expect(at(orphan)).toEqual({ status: "stopped" });

  if (process.platform !== "linux" || !Bun.which("flock")) return;
  mkdirSync(join(homes.codex, "thread-writer-locks"));
  const lock = join(homes.codex, "thread-writer-locks", `${CODEX_ID}.lock`);
  writeFileSync(lock, "");
  expect(lockHeld(lock)).toBe(false);
  expect(at(CODEX_ID)).toEqual({ status: "stopped" });
  const child = spawn("flock", [lock, "sleep", "5"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !lockHeld(lock); i++) await Bun.sleep(100);
    expect(at(CODEX_ID)).toEqual({ status: "loaded" });
  } finally {
    child.kill();
  }
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
  expect(withSessionState([readState(plain.id)])[0]).not.toHaveProperty("sessionState");
});

test("the server never forwards registry secrets", () => {
  const homes = fakeHomes();
  writeFileSync(
    join(homes.claude, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, procStart: "1", status: "idle", cwd: "/w", peerToken: "secret", messagingSocketPath: "/tmp/secret.sock" }),
  );
  const state = createPipeline({ repo, title: "t", source: "text", session: { harness: "claude", id: CLAUDE_ID, cwd: "/w" } });
  const out = JSON.stringify(withSessionState([state], { homes, now: Date.now() + 61_000 }));
  expect(out).toContain("sessionState");
  expect(out).not.toContain("secret");
});
