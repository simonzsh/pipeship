---
name: pipeship
description: Feature pipeline from a ticket to stacked PRs and a running test environment. Use ONLY when the user explicitly names pipeship (or a dictation variant like "pipe ship", "pipe chip", "pipechip") and asks to run a feature through it, e.g. "ship ABC-123 with pipeship". Never use it for ordinary feature, bug or code requests that do not name it.
argument-hint: "[quick|full] [--skip step,step] <ticket ref, URL or text>"
---

# pipeship

Run the pipeline below on: `$ARGUMENTS`

You are the orchestrator. Run each heavy step in a subagent with a clean context. Each step writes its result to a file in the pipeline directory; the next step reads that file. Keep the user's session for decisions and questions only.

## Helper

`pipeship` below means `bun "$(realpath <this skill's base directory>)/../../src/cli.ts"` (`realpath` matters when the skill is a symlink). It owns the state file `~/.pipeship/pipelines/<id>/state.json`, which the dashboard displays. Call it at every transition — the user follows the pipeline in the dashboard.

```
pipeship new --repo <path> --title <t> --source <s> [--ref <r>] [--url <u>] [--mode quick] [--skip a,b]
pipeship get <id>                      # read state: check stopRequested and skipped steps
pipeship step <id> <step> running|done|skipped|failed
pipeship status <id> waiting_for_user|running|ready|failed
pipeship chunk <id> <name> [--worktree p] [--branch b] [--status s] [--pr url]
pipeship recipe <repo>                 # the saved recipe to start the app, or "none"
pipeship preview <id> <worktree> [--recipe file]   # starts the app, prints the URL
pipeship dashboard                     # starts the dashboard if needed, prints its URL
```

Steps: `map`, `questions`, `plan`, `implement`, `review`, `stack`, `preview`.

## Rules

- **Each step**: `pipeship step <id> <step> running` when it starts, `done` when it ends.
- **Before each step**, run `pipeship get <id>`. If `stopRequested` is true, stop and tell the user. If the step is `skipped`, move on.
- **The user can change the steps at any time** ("skip the review", "ask me your questions anyway"). Update the state with `pipeship step <id> <step> skipped|pending` and continue.
- **Never skip a step another step needs**: the test environment needs a worktree; PRs need commits.
- On failure: `pipeship step <id> <step> failed`, explain what failed, and ask the user what to do.
- While this pipeline runs, it replaces process skills such as brainstorming, writing-plans, using-git-worktrees, subagent-driven-development and finishing-a-development-branch. Do not invoke them. The `simplify` and `code-review` skills in step 5 are fine.
- Every server you start outside `pipeship preview` must be stopped before you finish (`kill <PID>`, never `pkill -f`).

## Step 0 — Start

1. Parse `$ARGUMENTS` (if empty, use the user's request): an optional mode (`quick` or `full`, default `full`), an optional `--skip a,b`, and the ticket (reference, URL or text).
2. **Read the ticket** with whatever tool this session has for its source: an MCP server (Linear, Notion, Jira…), `gh issue view`, or fetching the URL. Plain text is the ticket itself. A bare reference like `ABC-123` does not name its source: infer it from the tools you have, and ask if unsure. If no tool can read the source, ask the user to paste the ticket.
3. The repo is the git root of the current directory. The base branch is the current branch. If the working tree has uncommitted changes, tell the user — they will not be in the worktrees.
4. `pipeship new ...` with the ticket title, source (`linear`, `notion`, `github`, `jira`, `url`, `text`…), ref and URL. Note the `id` and `dir` it prints.
5. Write the full ticket text to `<dir>/ticket.md`. Later steps read only this file, never the original source.
6. Run `pipeship dashboard` and give the user the URL.

## Step 1 — map

Subagent (Explore, model `sonnet`). Input: `ticket.md` and the repo. Output: `<dir>/map.md` with:
- every file the ticket touches (modules, routes, models, UI, tests), with paths and one line on what each does today;
- repo conventions to follow (structure, naming, test style);
- the exact **check commands** (lint, typecheck, tests) from the repo config;
- how to start the app: run `pipeship recipe <repo>`. If it prints `none` and the repo has a web app, write a draft recipe to `<dir>/recipe.json` (see "Test environment recipe"). If the repo has no app to run (a library, a CLI), say so.

In `quick` mode, keep the map short: only the files to change.

## Step 2 — questions (human pause)

1. Compare `ticket.md` with `map.md`. List what is missing or ambiguous.
2. Ask **all questions in one batch**, numbered. Format: "Today the code does X. Question: … Recommended: …". The user answers in one word or corrects.
3. In `full` mode, if the ticket is small (one coherent change), also propose switching to `quick`.
4. `pipeship status <id> waiting_for_user`, then **stop and wait** for the answers.
5. When the user answers: append the answers to `ticket.md` under `## Answers`, then `pipeship step <id> questions done`.

In `quick` mode, ask only **blocking** questions. If there are none, mark the step done and continue without a pause.

## Step 3 — plan

Subagent (Plan, model `opus`). Input: `ticket.md`, `map.md`. Output: `<dir>/plan.md` with:
1. **Contracts first**: the types, API routes and data formats shared between chunks. Fixed contracts are what make chunks independent.
2. **Chunks**: independent pieces of work, each with its files and its done criteria. Do not split for nothing — a small ticket is one chunk; every split adds integration risk.
3. **Stack order** by dependency: contracts, then back end, then front end.

When this step is skipped (`quick` mode), there is one chunk named after the ticket, and the plan is the ticket.

## Step 4 — implement

For each chunk, in stack order:
1. Branch `pipeship/<id>/<chunk>`, worktree `<dir>/worktrees/<chunk>`:
   `git -C <repo> worktree add <dir>/worktrees/<chunk> -b pipeship/<id>/<chunk> <base>`
2. `pipeship chunk <id> <chunk> --worktree <path> --branch <branch> --status coding`

Then launch **one subagent per chunk (model `sonnet`), all in the same message** so they run in parallel. Each subagent gets: its worktree path (it works only there), `ticket.md`, `map.md`, `plan.md` (contracts + its chunk), the check commands. It must: implement its chunk against the contracts, make the checks pass, commit, and report what it did. Install dependencies in the worktree if the checks need them.

When all are done, **restack**: in stack order, rebase each chunk branch onto the previous one (`git -C <worktree> rebase <previous branch>`). The last chunk branch is the **top of the stack** and contains the whole feature. Run the checks on the top. Update each chunk with `--status done`.

## Step 5 — review

1. **Global review** (one subagent, model `opus`, top worktree, diff `<base>..<top branch>`): duplicated helpers across chunks, contract mismatches, integration bugs. Parallel agents cannot see each other — only this review finds these.
2. **Cleanup per chunk** (one subagent per chunk, model `sonnet`): simplification, dead code, repo conventions, readability. Use the `simplify` and `code-review` skills if available.
3. Fix each problem **in the worktree of the chunk that owns the code**, commit, then restack the later chunks.
4. **Safety rule**: after every pass that changes code, re-run the checks. If a check fails, fix it or revert the pass.

Write a short summary to `<dir>/review.md`.

## Step 6 — stack

1. Push every chunk branch.
2. In stack order, open one PR per chunk: `gh pr create --head <branch> --base <previous branch>` (the first PR targets `<base>`). Title from the ticket and chunk; body: what this chunk does, a link to the ticket, and the stack position ("2/3").
3. `pipeship chunk <id> <chunk> --pr <url> --status pr`.

If the repo has no remote, skip this step and tell the user.

## Step 7 — preview

If the repo has no app to run, mark this step `skipped`: once every step is done or skipped, the pipeline becomes `ready` on its own.

Run `pipeship preview <id> <top worktree>`, with `--recipe <dir>/recipe.json` if step 1 wrote a draft. It copies local files, installs, starts the app on a free port, waits until it answers, and marks the pipeline `ready`. A draft recipe that works is saved, so later pipelines in this repo skip this work. Give the user the URL.

If it fails, it prints the log tail: diagnose, fix the recipe or the code, and retry up to twice before asking the user. To fix the recipe: if `pipeship recipe <repo>` points to a `.pipeship.json` in the repo, fix that file in the top worktree (it will be part of the PRs) and tell the user; otherwise write a fixed draft and pass it with `--recipe`.

## End

Give the user a short summary: the test URL, the PRs in stack order, and anything to check by hand. The test server keeps running on purpose; the user stops it with the dashboard's "Stop pipeline" button.

## Test environment recipe

You write the recipe; the user never has to. Read `package.json`, the lock file, the README and the dev scripts to find the package manager, the dev command and how the app picks its port. A `.pipeship.json` at the repo root, if the team shares one, wins over the saved recipe.

```json
{
  "install": "bun install",
  "start": "bun run dev",
  "portEnv": "PORT",
  "copyFiles": [".env.local"],
  "readyPath": "/"
}
```

- `start` must honour the port in `portEnv` (e.g. `next dev -p $PORT` if the framework ignores `PORT`).
- `copyFiles`: untracked local files the app needs (`.env`, `.env.local`…), copied from the main checkout into the worktree. List them with `git -C <repo> status --ignored --short`.
- The app is served as `http://<ticket>.localhost:<port>`. Some dev servers reject unknown hosts (Next.js `allowedDevOrigins`, Vite `server.allowedHosts`): pipeship detects this and prints `http://localhost:<port>` instead. Never change the repo's config only for pipeship.
