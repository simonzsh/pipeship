import { resolve } from "node:path";
import { listStates, pipelineDir, type State, type Status } from "./state.ts";

// Statuses that still need the agent. ready, done, failed and archived do not.
export const UNFINISHED: readonly Status[] = ["running", "waiting_for_user", "stopped"];

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  hook_event_name?: string;
}

type Env = Record<string, string | undefined>;

export function parseHookInput(raw: string): HookInput {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

// Match by session id. After /clear the id changes, so fall back to the same harness and cwd.
export function pendingPipelines(states: State[], input: HookInput, env: Env = process.env): State[] {
  const id = input.session_id ?? env.CLAUDE_CODE_SESSION_ID;
  if (!id) return [];
  const unfinished = states.filter((s) => UNFINISHED.includes(s.status));
  const byId = unfinished.filter((s) => s.session?.id === id);
  if (byId.length > 0 || input.source !== "clear" || !input.cwd) return byId;
  return unfinished.filter((s) => s.session?.harness === "claude" && s.session.cwd === input.cwd);
}

export function reminderText(states: State[], paths: { skill: string; helper: string }): string {
  const lines = states.map((s) => {
    const waiting = s.waiting ? `, waiting: ${s.waiting.reason ?? s.waiting.step}` : "";
    return `- ${s.id} "${s.ticket.title}": ${s.status}, step ${s.step}${waiting}, dir ${pipelineDir(s.id)}`;
  });
  return [
    "pipeship: this session has unfinished pipelines.",
    ...lines,
    `Before you go on, re-read the skill: ${paths.skill}. \`pipeship\` is ${paths.helper}.`,
    "Key rules:",
    "- one subagent per heavy step; keep the main session for decisions;",
    "- `pipeship get <id>` before each step (stopRequested, skipped steps);",
    "- `pipeship step <id> <step> running` when a step starts, `done` when it ends;",
    "- one test suite at a time on the machine, targeted tests only.",
    "A stopped pipeline goes on only if the user asks.",
  ].join("\n");
}

// Returns "" (inject nothing) or one JSON line for Claude Code.
export function sessionStartOutput(
  input: HookInput,
  opts: { states?: State[]; env?: Env; paths?: { skill: string; helper: string } } = {},
): string {
  const found = pendingPipelines(opts.states ?? listStates(), input, opts.env);
  if (found.length === 0) return "";
  const paths = opts.paths ?? {
    skill: resolve(import.meta.dir, "../skills/ship/SKILL.md"),
    helper: resolve(import.meta.dir, "../scripts/pipeship"),
  };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: reminderText(found, paths) } });
}

// A hook must never break a session: any error prints nothing and exits 0.
if (import.meta.main) {
  try {
    const out = sessionStartOutput(parseHookInput(await Bun.stdin.text()));
    if (out) process.stdout.write(`${out}\n`);
  } catch {}
}
