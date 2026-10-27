import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseHookInput, pendingPipelines, reminderText, ROUTING_RULE, sessionStartOutput, UNFINISHED } from "../src/hook.ts";
import type { State, Status } from "../src/state.ts";

const root = mkdtempSync(join(tmpdir(), "pipeship-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const paths = { skill: "/plugin/skills/run/SKILL.md", helper: "/plugin/scripts/pipeship" };

function fixture(id: string, status: Status, session: State["session"] | null = { harness: "claude", id: "s1", cwd: "/work" }): State {
  return {
    id,
    ticket: { title: `Ticket ${id}`, links: [] },
    repos: [],
    mode: "full",
    status,
    step: "implement",
    steps: [],
    chunks: [],
    ...(session && { session }),
    stopRequested: status === "stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("pendingPipelines", () => {
  test("keeps only the unfinished pipelines of the session", () => {
    const all: Status[] = ["running", "waiting_for_user", "ready", "done", "failed", "stopped", "archived"];
    const states = all.map((s) => fixture(s, s));
    const found = pendingPipelines(states, { session_id: "s1" }, {}).map((s) => s.id);
    expect(found).toEqual([...UNFINISHED]);
    expect(pendingPipelines([fixture("a", "running", { harness: "claude", id: "other", cwd: "/work" })], { session_id: "s1" }, {})).toEqual([]);
    expect(pendingPipelines([fixture("a", "running", null)], { session_id: "s1" }, {})).toEqual([]);
  });

  test("ignores a pipeline with the dashboard off, by session id and by folder", () => {
    const off = { ...fixture("off", "running"), dashboard: false };
    const on = fixture("on", "running");
    expect(pendingPipelines([off, on], { session_id: "s1" }, {}).map((s) => s.id)).toEqual(["on"]);
    expect(pendingPipelines([off], { session_id: "new", source: "clear", cwd: "/work" }, {})).toEqual([]);
    expect(pendingPipelines([on], { session_id: "new", source: "clear", cwd: "/work" }, {})).toHaveLength(1);
  });

  test("uses CLAUDE_CODE_SESSION_ID when the input has no session id, and nothing without any id", () => {
    const states = [fixture("a", "running")];
    expect(pendingPipelines(states, {}, { CLAUDE_CODE_SESSION_ID: "s1" })).toHaveLength(1);
    expect(pendingPipelines(states, { session_id: "other" }, { CLAUDE_CODE_SESSION_ID: "s1" })).toEqual([]);
    expect(pendingPipelines(states, {}, {})).toEqual([]);
  });

  test("matches a codex pipeline by session_id and by CODEX_THREAD_ID", () => {
    const states = [fixture("c", "running", { harness: "codex", id: "thread-1", cwd: "/work" })];
    expect(pendingPipelines(states, { session_id: "thread-1" }, {})).toHaveLength(1);
    expect(pendingPipelines(states, {}, { CODEX_THREAD_ID: "thread-1" })).toHaveLength(1);
    expect(pendingPipelines(states, {}, { CLAUDE_CODE_SESSION_ID: "x", CODEX_THREAD_ID: "thread-1" })).toEqual([]);
    expect(pendingPipelines(states, {}, { CODEX_THREAD_ID: "other" })).toEqual([]);
  });

  test("after /clear, falls back to the same claude harness and cwd", () => {
    const states = [
      fixture("same", "running", { harness: "claude", id: "old", cwd: "/work" }),
      fixture("elsewhere", "running", { harness: "claude", id: "old", cwd: "/other" }),
      fixture("codex", "running", { harness: "codex", id: "old", cwd: "/work" }),
      fixture("done", "done", { harness: "claude", id: "old", cwd: "/work" }),
    ];
    const input = { session_id: "new", cwd: "/work" };
    expect(pendingPipelines(states, { ...input, source: "clear" }, {}).map((s) => s.id)).toEqual(["same"]);
    expect(pendingPipelines(states, { ...input, source: "compact" }, {})).toEqual([]);
    // In Codex (CODEX_THREAD_ID set) the fallback picks codex pipelines instead.
    expect(pendingPipelines(states, { ...input, source: "clear" }, { CODEX_THREAD_ID: "t" }).map((s) => s.id)).toEqual(["codex"]);
    // Env vars leak into nested agents: with both set, Claude wins, like for the session id.
    expect(pendingPipelines(states, { ...input, source: "clear" }, { CLAUDE_CODE_SESSION_ID: "c", CODEX_THREAD_ID: "t" }).map((s) => s.id)).toEqual(["same"]);
    // The fallback keeps running and waiting_for_user only, not stopped.
    const mixed = ["running", "waiting_for_user", "stopped"].map((st) => fixture(st, st as Status, { harness: "claude", id: "old", cwd: "/work" }));
    expect(pendingPipelines(mixed, { ...input, source: "clear" }, {}).map((s) => s.id)).toEqual(["running", "waiting_for_user"]);
    // A match by id wins: the fallback does not add other pipelines.
    const byId = [...states, fixture("mine", "running", { harness: "claude", id: "new", cwd: "/x" })];
    expect(pendingPipelines(byId, { ...input, source: "clear" }, {}).map((s) => s.id)).toEqual(["mine"]);
  });
});

describe("reminder", () => {
  test("the text has the pipeline, the paths and the key rules", () => {
    const waiting = { ...fixture("abc-1", "waiting_for_user"), waiting: { step: "questions" as const, reason: "need an answer" } };
    const text = reminderText([waiting], paths);
    expect(text).toContain('abc-1 "Ticket abc-1": waiting_for_user, step implement, waiting: need an answer');
    expect(text).toContain("pipelines/abc-1");
    expect(text).toContain(paths.skill);
    expect(text).toContain(paths.helper);
    for (const rule of ["one subagent per heavy step", "pipeship get <id>", "pipeship step <id> <step> running", "pipeship pr <id>", "one test suite at a time"]) {
      expect(text).toContain(rule);
    }
  });

  test("a match by folder only says the pipelines may belong to the session", () => {
    const states = [fixture("a", "running", { harness: "claude", id: "old", cwd: "/work" })];
    const input = { session_id: "new", cwd: "/work", source: "clear" };
    const text = JSON.parse(sessionStartOutput(input, { states, env: {}, paths })).hookSpecificOutput.additionalContext;
    expect(text).toContain("may belong to this session (same folder)");
    expect(text).not.toContain("this session has");
    const byId = JSON.parse(sessionStartOutput({ session_id: "old" }, { states, env: {}, paths })).hookSpecificOutput.additionalContext;
    expect(byId).toContain("this session has unfinished pipelines");
  });

  test("sessionStartOutput has only the routing rule without a pipeline", () => {
    for (const states of [[], [fixture("a", "done")]]) {
      const json = JSON.parse(sessionStartOutput({ session_id: "s1" }, { states, env: {}, paths }));
      expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(json.hookSpecificOutput.additionalContext).toBe(ROUTING_RULE);
    }
  });

  test("sessionStartOutput puts the routing rule before the reminder, on one JSON line", () => {
    const out = sessionStartOutput({ session_id: "s1" }, { states: [fixture("a", "running")], env: {}, paths });
    expect(out).not.toContain("\n");
    const text: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(text.startsWith(ROUTING_RULE)).toBe(true);
    expect(text).toContain('a "Ticket a"');
  });

  test("the routing rule sends work requests to pipeship:run and excludes small edits", () => {
    for (const part of ["`pipeship:run`", "`$run` in Codex", "ticket to handle", "delegated request", "small edit in one file", "question"]) {
      expect(ROUTING_RULE).toContain(part);
    }
  });

  test("the README AGENTS.md snippet holds the routing rule verbatim", () => {
    const readme = readFileSync(resolve(import.meta.dir, "../README.md"), "utf8");
    expect(readme).toContain(`\`\`\`\n${ROUTING_RULE}\n\`\`\``);
  });

  test("the default skill path points to an existing SKILL.md", () => {
    const out = sessionStartOutput({ session_id: "s1" }, { states: [fixture("a", "running")], env: {} });
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    const path = text.match(/re-read the skill: (\S+SKILL\.md)/)?.[1];
    expect(path).toBeDefined();
    expect(existsSync(path)).toBe(true);
  });

  test("parseHookInput returns {} for bad or empty input", () => {
    expect(parseHookInput("garbage")).toEqual({});
    expect(parseHookInput("")).toEqual({});
    expect(parseHookInput("[1]")).toEqual({});
    expect(parseHookInput('{"session_id":"s1","source":"compact"}')).toEqual({ session_id: "s1", source: "compact" });
  });
});

describe("hook script", () => {
  const script = resolve(import.meta.dir, "../hooks/session-start");
  const home = join(root, "home");
  const dir = join(home, "pipelines", "e2e");
  mkdirSync(dir, { recursive: true });
  // readState derives the status from the steps: one pending step keeps the pipeline running.
  const e2e = { ...fixture("e2e", "running", { harness: "claude", id: "s-e2e", cwd: "/work" }), steps: [{ name: "explore", status: "pending" }] };
  writeFileSync(join(dir, "state.json"), JSON.stringify(e2e));
  // Never leak the session id of the shell that runs the tests.
  const { CLAUDE_CODE_SESSION_ID: _, ...base } = process.env;
  const run = (stdin: string) => spawnSync(script, { input: stdin, encoding: "utf8", env: { ...base, PIPESHIP_HOME: home } });

  test("prints the reminder for a pipeline of the session", () => {
    const r = run(JSON.stringify({ session_id: "s-e2e", source: "compact", hook_event_name: "SessionStart" }));
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput.additionalContext).toContain("e2e");
    expect(json.hookSpecificOutput.additionalContext).toContain(join(home, "pipelines", "e2e"));
  });

  test("one corrupt state.json does not silence the other pipelines", () => {
    const bad = join(home, "pipelines", "corrupt");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "state.json"), "{ not json");
    const r = run(JSON.stringify({ session_id: "s-e2e", source: "compact" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("e2e");
    rmSync(bad, { recursive: true, force: true });
  });

  test("prints only the routing rule for another session or bad stdin, and exits 0", () => {
    for (const stdin of [JSON.stringify({ session_id: "other" }), "garbage", ""]) {
      const r = run(stdin);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(ROUTING_RULE);
    }
  });

  test("hooks.json declares the SessionStart hook on an executable script", () => {
    const config = JSON.parse(readFileSync(resolve(import.meta.dir, "../hooks/hooks.json"), "utf8"));
    const entry = config.hooks.SessionStart[0];
    expect(entry.matcher).toBe("startup|resume|clear|compact");
    const command: string = entry.hooks[0].command;
    expect(entry.hooks[0].type).toBe("command");
    const target = command.replace(/^"|"$/g, "").replace("${CLAUDE_PLUGIN_ROOT}", resolve(import.meta.dir, ".."));
    expect(target).toBe(script);
    accessSync(target, constants.X_OK);
  });
});
