---
name: ship
description: Feature pipeline from a ticket to stacked PRs and a running test environment. Use ONLY when the user explicitly names pipeship (or a dictation variant like "pipe ship", "pipe chip", "pipechip") and asks to run a feature through it, e.g. "ship ABC-123 with pipeship". Never use it for ordinary feature, bug or code requests that do not name it.
argument-hint: "[quick|full] [--skip step,step] <ticket ref, URL or text>"
---

# pipeship

Run the pipeline below on the user's ticket: `$ARGUMENTS`

You are the orchestrator. Run each heavy step in a subagent with a clean context. Each step writes its result to a file in the pipeline directory; the next step reads that file. Keep the user's session for decisions and questions only.

## Claude Code and Codex

This skill runs in both. Where they differ:
- **Arguments**: Claude Code fills `$ARGUMENTS`. Codex leaves it as is: take the ticket and options from the user's message.
- **Subagents**: use your harness's subagent tool (Claude Code: `Agent`; Codex: spawn sub-agents). To run subagents in parallel, start them together. If you have none, run the step yourself.
- **Models**: `opus` and `sonnet` below are Claude Code model names. In another harness, use your strongest model for `opus` steps and your default model for `sonnet` steps.
- **Codex sandbox**: pipeship writes outside the repo (`~/.pipeship`), starts background servers and pushes branches. If the sandbox blocks a command, ask the user to approve it or to relax the sandbox. Never work around it.

## Helper

`pipeship` below means `"$(realpath <this skill's base directory>)/../../scripts/pipeship"` (`realpath` matters when the skill is a symlink). On first use it installs its dependencies, which takes a few seconds. It owns the state file `~/.pipeship/pipelines/<id>/state.json`, which the dashboard displays. Call it at every transition — the user follows the pipeline in the dashboard.

```
pipeship new [--repo <path>]... --title <t> [--source <s>] [--ref <r> --url <u>]... [--name <words>] [--mode quick] [--skip a,b]
pipeship repo <id> <path>              # add a repo to the pipeline (once per repo); prints its base and whether it is dirty
pipeship get <id>                      # read state: check stopRequested and skipped steps
pipeship step <id> <step> running|done|skipped|failed
pipeship mode <id> quick|full         # switch the mode after creation; quick skips the pending plan step
pipeship status <id> waiting_for_user|running|ready|failed
pipeship chunk <id> <name> [--repo r] [--worktree p] [--branch b] [--status s] [--pr url]   # --repo (name or path) needed for a new chunk with several repos
pipeship recipe <repo>...              # the saved recipe to start the app for these repos, or "none"
pipeship preview <id> [<worktree>] [--recipe file]   # starts the app, prints the URL(s); each service runs from the top worktree of its repo
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
- If the dashboard shows *Agent stopped*, the user can resume with the command copied from the agent logo in the pipeline header, then continue from the first step that is not done or skipped (`pipeship get <id>`).
- Every server you start outside `pipeship preview` must be stopped before you finish (`kill <PID>`, never `pkill -f`).

## Step 0 — Start

1. Parse the arguments (if `$ARGUMENTS` is empty or was not replaced, use the user's request): an optional mode (`quick` or `full`, default `full`), an optional `--skip a,b`, and the ticket (reference, URL or text).
2. **Read the ticket** with whatever tool this session has for its source: an MCP server (Linear, Notion, Jira…), `gh issue view`, or fetching the URL. Plain text is the ticket itself. A bare reference like `ABC-123` does not name its source: infer it from the tools you have, and ask if unsure. If no tool can read the source, ask the user to paste the ticket.
3. The repos are the git root of the current directory, plus any repo the user names. If the current directory is not in a git repo, run `new` without `--repo`: the map step adds the repos. The base branch of each repo is its current branch. If a working tree has uncommitted changes, tell the user — they will not be in the worktrees.
4. `pipeship new ...` with one `--repo <path>` per repo, the ticket title, the source (`linear`, `notion`, `github`, `jira`, `url`…; omit `--source` for a plain-text ticket), and one `--ref`/`--url` pair per ticket when the pipeline covers several (never join refs into one `--ref`). `new --repo` and `repo` reduce a path to its git root and refuse a path outside git. Note the `id` and `dir` it prints. It lists each repo with its `base` and `dirty`: tell the user about dirty repos. `pipeship new` records the session that runs it (harness, id, cwd). Run it from this orchestrator session, never from a subagent.
   - For a plain-text ticket, pick a 2 or 3 word name that sums it up (`session-link`, `quick-mode`) and pass it with `--name`. Ticket refs win over the name.
5. Write the full ticket text to `<dir>/ticket.md`. Later steps read only this file, never the original source.
6. Run `pipeship dashboard` and give the user the URL.

## Step 1 — map

Subagent (read-only, model `sonnet`; Claude Code: `Explore` type). Input: `ticket.md` and the repos. Output: `<dir>/map.md` with:
- `## Repos`: other repos the ticket touches, when it names them or sibling git repos in the parent folder of each repo's git root match its code. Give the path and the reason. The subagent stays read-only: you run `pipeship repo <id> <path>` for each one and tell the user about dirty repos;
- every file the ticket touches (modules, routes, models, UI, tests), with paths and one line on what each does today (per repo, when there are several);
- repo conventions to follow (structure, naming, test style, branch names from recent `git branch -r`), per repo;
- the exact **check commands** (lint, typecheck, tests) from each repo config;
- how to start the app: run `pipeship recipe <repo>...` with all the repos. If it prints `none` and the repo has anything that serves requests (a web app, an API, an MCP server, a worker with a health route), write a draft recipe to `<dir>/recipe.json` (see "Test environment recipe"). If the repo runs several apps (a monorepo, a front and an API), the recipe lists one service per app. Back-end only changes count: do not conclude "no preview needed" because the change has no UI. Say "nothing to run" only for a pure library, a CLI that cannot start, or a docs-only change. List what the app needs to run (database, env files, seed data, other services) and how to get test data locally.

In `quick` mode, do the map yourself in the main session, not in a subagent: on a small ticket a subagent costs as much as the work. Keep the map short: only the files to change, the check commands and how to start the app.

## Step 2 — questions (human pause)

1. Compare `ticket.md` with `map.md`. List what is missing or ambiguous. With several repos, ask the user to confirm the repo list. The plan and the chunks start only once the list is fixed.
2. Ask **all questions in one batch**, numbered. Format: "Today the code does X. Question: … Recommended: …". The user answers in one word or corrects.
3. In `full` mode, if the ticket is small (one coherent change), also propose switching to `quick`. When the user accepts, run `pipeship mode <id> quick` so the dashboard shows the badge.
4. `pipeship status <id> waiting_for_user`, then **stop and wait** for the answers.
5. When the user answers: append the answers to `ticket.md` under `## Answers`, then `pipeship step <id> questions done`.

In `quick` mode, ask only **blocking** questions. When the map step added repos, the repo list is a blocking question. If there are none, mark the step done and continue without a pause.

## Step 3 — plan

Subagent (model `opus`; Claude Code: `Plan` type). Input: `ticket.md`, `map.md`. Output: `<dir>/plan.md` with:
1. **Contracts first**: the types, API routes and data formats shared between chunks. Fixed contracts are what make chunks independent. Write the contracts between repos once, here.
2. **Chunks**: independent pieces of work, each with its repo, its files and its done criteria. Chunk names are unique across the pipeline. Do not split for nothing — a small ticket is one chunk; every split adds integration risk.
3. **Stack order** by dependency: contracts, then back end, then front end. Each repo has its own stack order.

When this step is skipped (`quick` mode), there is one chunk named after the ticket, and the plan is the ticket. With several repos, there is one chunk per repo, named after the repo's folder, and one PR per repo.

## Step 4 — implement

For each chunk, in stack order:
1. Branch `<ticket>/<chunk>`, worktree `<dir>/worktrees/<chunk>`:
   `git -C <chunk's repo> worktree add <dir>/worktrees/<chunk> -b <ticket>/<chunk> <that repo's base>`
   - `<ticket>` is the first ticket ref in lowercase (`abc-123`), or the 2 or 3 word `--name` for a plain-text ticket. Keep chunk names short too (`api`, `ui`, `backfill`): e.g. `abc-123/api`.
   - If the repo has a branch naming convention (see `map.md`), follow it instead, e.g. `feat/abc-123-api`.
   - If the branch already exists, add `-2`.
2. `pipeship chunk <id> <chunk> --worktree <path> --branch <branch> --status coding`. With several repos, add `--repo <name>`.

Then launch **one subagent per chunk (model `sonnet`), started together** so they run in parallel. Each subagent gets: its worktree path (it works only there), `ticket.md`, `map.md`, `plan.md` (contracts + its chunk), the check commands. It must: implement its chunk against the contracts, make the checks pass, commit, and report what it did. Install dependencies in the worktree if the checks need them.

As soon as a subagent reports, run `pipeship chunk <id> <chunk> --status done`. Do not wait for the other chunks: the user follows each chunk live in the dashboard. If the chunk failed, use `--status failed`.

When all are done, **restack**: in stack order, rebase each chunk branch onto the previous one (`git -C <worktree> rebase <previous branch>`). The last chunk branch is the **top of the stack** and contains the whole feature. Run the checks on the top. With several repos, restack each repo on its own: each repo has its own top. If the restack or the checks fail, set the chunks to fix back to `--status coding`.

## Step 5 — review

1. **Global review** (one subagent, model `opus`, top worktree, diff `<base>..<top branch>`; with several repos, the top worktree and diff of every repo): duplicated helpers across chunks, contract mismatches, integration bugs. Parallel agents cannot see each other — only this review finds these.
2. **Cleanup per chunk** (one subagent per chunk, model `sonnet`): simplification, dead code, repo conventions, readability. Use the `simplify` and `code-review` skills if available.
3. Fix each problem **in the worktree of the chunk that owns the code**, commit, then restack the later chunks of that repo.
4. **Safety rule**: after every pass that changes code, re-run the checks. If a check fails, fix it or revert the pass.

In `quick` mode, skip the global review. Run one cleanup pass (one subagent, model `sonnet`) on the whole diff: simplification, dead code, repo conventions. Use the `simplify` and `code-review` skills if available. Then run the checks once. Quick mode uses no `opus` step: every subagent is `sonnet`.

Write a short summary to `<dir>/review.md`.

## Step 6 — stack

1. Push every chunk branch.
2. In stack order, open one PR per chunk: `gh pr create --head <branch> --base <previous branch>` (the first PR of each repo targets that repo's base). Title from the ticket and chunk; body: what this chunk does, a link to the ticket, and the stack position ("2/3").
3. `pipeship chunk <id> <chunk> --pr <url> --status pr`.

With several repos, once every PR exists, add a "Related PRs" list with the other repos' PRs to each PR body (`gh pr edit <url> --body-file <file>`).

If a repo has no remote, skip its PRs and tell the user.

## Step 7 — preview and verify

Run the changed code, front end or back end. An API, MCP or engine change needs a running server as much as a UI change: unit tests do not show what a real client gets. Mark this step `skipped` only when nothing the change touches can run (a pure library with no server, a CLI you cannot start, a docs-only change), and say why in the final summary. "No UI" and "engine only" are not reasons to skip. Once every step is done or skipped, the pipeline becomes `ready` on its own.

1. **Start.** First run `pipeship recipe <repo>...` again with the final repo list. If the list changed since step 1, update the `repo` names in the draft. Then run `pipeship preview <id>`. It uses each repo's top worktree. Add `--recipe <dir>/recipe.json` if there is a draft. It copies local files, installs, starts each service of the recipe on its own free port (back ends first, then fronts), waits until each answers, and marks the pipeline `ready`. A draft recipe that works is saved, so later pipelines in this repo skip this work. Give the user the URLs it prints (the first is the main front). Services the app needs (a local database, a queue) belong in a `start` command of the recipe, so the dashboard's "Stop preview" button stops them with the app (see "Test environment recipe"). Other one-off setup is fine to run yourself; test data follows the data rule of step 7.
2. **Verify.** Use the changed behaviour the way its client does, and write what you called and what came back to `<dir>/verify.md`: a UI change in a browser (the preview tools of your harness), an HTTP API with `curl`, an MCP or other protocol with a real client. Cover the main path and one failure path. If you cannot exercise it (no test data, a missing service), say so in the summary. Never claim it works from unit tests alone.
3. **Fix.** If verification fails, fix the code in the worktree of the chunk that owns it, commit, restack and re-run the checks. Push only if step 6 opened PRs.
4. **Test guide.** After verify, write `<dir>/test.md` for the user, in the user's language. The dashboard shows it in the pipeline's Test tab, so the user can test without leaving the dashboard. `verify.md` stays your evidence; `test.md` is the user's guide. Keep it short:
   - the direct URL of the changed page, not only the root;
   - how to log in if the app needs it (which local account), never a secret;
   - 3 to 5 steps, each with its expected result;
   - what you could not test, and why.

   Rules:
   - **Data.** Use the data already there. Create data only in a local database, and list it in the guide. If the database is not local, create nothing and say so in the guide.
   - **No external effects.** Never send an SMS, an email or a payment, and never call a real third-party service. If the feature depends on one, mark it "to test by hand" in the guide and explain how.

If the preview fails to start, it prints the log tail: diagnose, fix the recipe or the code, and retry up to twice before asking the user. To fix the recipe: if `pipeship recipe <repo>` points to a `.pipeship.json` in the repo, fix that file in the top worktree (it will be part of the PRs) and tell the user; otherwise write a fixed draft and pass it with `--recipe`. With several repos there is no `.pipeship.json`: fix the saved recipe with a new draft passed with `--recipe`.

## End

Give the user a short summary: the test URL, the PRs in stack order (per repo), what the verification covered (or why it was skipped), and anything to check by hand. Point to the test guide: the user finds it in the pipeline's Test tab. The test servers keep running on purpose; the user stops them with the dashboard's "Stop preview" button.

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
- Services the app needs must run in the foreground inside `start`, e.g. `docker compose up db & bun run dev`. pipeship stops the whole process group, so they stop with the app. A detached service (`docker compose up -d`) would outlive the pipeline. With `services`, a dependency such as a database can be its own service (`"ready": "tcp"`, `fixedPort` if its port cannot be set).
- `copyFiles`: untracked local files the app needs (`.env`, `.env.local`…), copied from the repo's own checkout into the worktree. List them with `git -C <repo> status --ignored --short`.
- Every service is served as `http://localhost:<port>`. Never change the repo's config only for pipeship.

### Several services

For a monorepo or a front with its own API, list one service per app. `install` and `copyFiles` stay at the top level. Never put a top-level `start` next to `services`.

```json
{
  "install": "pnpm install",
  "copyFiles": [".env"],
  "services": [
    { "name": "api", "kind": "back", "start": "pnpm --filter api dev", "portEnv": "API_PORT", "readyPath": "/health" },
    { "name": "web", "kind": "front", "start": "pnpm --filter web exec next dev -p $PORT",
      "env": { "API_URL": "http://localhost:${api.port}" } },
    { "name": "db", "kind": "infra", "start": "docker compose up db", "ready": "tcp", "fixedPort": 5432 }
  ]
}
```

- One service per app: `name`, `kind` (`front`, `back` or another word), its own `start`, `portEnv`, `readyPath` and `env`.
- Set the port through `portEnv` or a flag in `start` (`next dev -p $PORT`, `vite --port $PORT`).
- Never use the repo's global dev command (`turbo dev`, a root `pnpm dev`) when it starts apps on fixed ports.
- A service gets another service's URL through `env`: `"API_URL": "http://localhost:${api.port}"`.
- pipeship picks every port first: fronts from 3000, other kinds from 4000 (4400 is skipped).
- Back ends and other kinds start first, then fronts. Each service must answer on its `readyPath` before the next one starts (`"ready": "tcp"` only waits for a connection to its port, for a database or queue).
- Never change the repo's config only for pipeship. If a port truly cannot be set, write `"fixedPort": <port>`. pipeship then refuses to start a second pipeline that shares a repo while one runs.

### Several repos

For a ticket that spans repos, list `services` and give each one its `repo` (the repo's folder name). Each service runs from the top worktree of its repo.

```json
{
  "services": [
    { "name": "api", "kind": "back", "repo": "shop-api", "install": "pnpm install", "copyFiles": [".env"],
      "start": "pnpm dev", "portEnv": "PORT", "readyPath": "/health" },
    { "name": "web", "kind": "front", "repo": "shop-web", "install": "bun install",
      "start": "bun run dev --port $PORT", "env": { "API_URL": "http://localhost:${api.port}" } }
  ]
}
```

- `repo` is required on every service.
- Put `install` and `copyFiles` on the services, never at the top level.
- The recipe is saved for this set of repos.
