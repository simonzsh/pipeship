# pipeship

Feature pipeline for Claude Code and Codex. Give it a ticket or an issue from any source; it maps the code, asks its questions in one batch, plans, implements chunks in parallel worktrees, cleans up the code, opens stacked PRs, and starts the app so you can test it at a URL. It works with [T3 Code](https://github.com/pingdotgg/t3code): each pipeline links back to its T3 Code thread.

## Install

Requires [Bun](https://bun.sh), git and `gh`.

In Claude Code, from your shell, then start a new session:

```sh
claude plugin marketplace add simonzsh/pipeship
claude plugin install pipeship@pipeship
```

Or in one step inside a session: `/plugin install pipeship --marketplace simonzsh/pipeship`. Updates arrive with `claude plugin update pipeship@pipeship`, or automatically once you turn on auto-update for the marketplace in `/plugin`.

In Codex, from your shell, then start a new session:

```sh
codex plugin marketplace add simonzsh/pipeship
codex plugin add pipeship@pipeship
```

The first run installs the dependencies, which takes a few seconds.

To work on pipeship itself, clone the repo, run `bun install`, and link the skill instead: `ln -s "$PWD/skills/ship" ~/.claude/skills/ship`. Changes then apply at once.

## Usage

Give pipeship a ticket: a reference (`ABC-123`), a URL (Linear, Notion, GitHub, Jira…) or plain text. It reads the ticket with the tools your session has, such as an MCP server or `gh`.

### In Claude Code

Type `/pipeship:ship` followed by the ticket (`/ship` if you use the dev link):

```
/pipeship:ship ABC-123
/pipeship:ship quick https://github.com/org/repo/issues/42
/pipeship:ship --skip questions,stack "Add a date filter to the orders page"
```

You can also ask in plain words: "ship ABC-123 with pipeship".

### In Codex

In Codex, `$` calls a skill by name (type `$` to pick one from a list):

```
$ship ABC-123
$ship quick https://github.com/org/repo/issues/42
```

You can also ask in plain words: "ship ABC-123 with pipeship". pipeship writes to `~/.pipeship`, starts background servers and pushes branches, so Codex's default sandbox asks for approval: approve these commands, or run Codex with a sandbox that allows them.

### Options

- **Modes**: `full` (default, all 7 steps) and `quick` (one chunk, blocking questions only, explore in the main session, one `sonnet` cleanup pass instead of the full review, no `opus`).
- **`--skip`** removes steps, e.g. `--skip questions,stack`. You can also say "skip the review" during the run.
- **Several repos**: a ticket can span several repos. Pass `--repo` once per repo, or let the explore step find them. Each repo gets its own stack of PRs.
- pipeship only starts when you name it. It does not run on ordinary feature requests.

## Test environment

At the end of a pipeline, the app runs from the feature's worktree. Each front service takes the first free port from 3000. Back ends and other kinds take the first free port from 4000 (4400, the dashboard, is skipped). Every service is served at `http://localhost:<port>`.

You do not configure anything: on the first pipeline in a repo, Claude reads the project and writes a recipe (install and start commands, port variable, local files to copy). Once the app starts, the recipe is saved in `~/.pipeship/recipes/` and reused. To share a recipe with your team, commit it as `.pipeship.json` at the repo root:

```json
{ "install": "bun install", "start": "bun run dev", "portEnv": "PORT", "copyFiles": [".env.local"], "readyPath": "/" }
```

This recipe is one front service. For a monorepo, list `services` instead. pipeship picks every port first, so a service can read another one's port in `env`. Back ends start first, then fronts; each service must answer on its `readyPath` before the next one starts.

```json
{
  "install": "pnpm install",
  "services": [
    { "name": "api", "kind": "back", "start": "pnpm --filter api dev", "portEnv": "API_PORT", "readyPath": "/health" },
    { "name": "web", "kind": "front", "start": "pnpm --filter web exec next dev -p $PORT",
      "env": { "API_URL": "http://localhost:${api.port}" } }
  ]
}
```

For a ticket that spans several repos, give each service its `repo` (the repo's folder name). It runs from the top worktree of that repo. Put `install` and `copyFiles` on the services. The recipe is saved for this set of repos. A pipeline with several repos never reads `.pipeship.json`.

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

A service that cannot take its port from the environment can set `"fixedPort": <port>`. pipeship then refuses to start a second pipeline that shares a repo while one test environment runs.

## Dashboard

The dashboard on http://localhost:4400 has two columns.

- **Left: the pipelines**, grouped by status, each with its ticket, its steps and its status. The repo filter sits on top of the list.
- **Right: the selected pipeline.** The first one is selected by default, and `?p=<id>` in the URL links to a pipeline. The header stays on top while the rest scrolls: title, status, ticket links, repos, steps, and the actions.

Under 900 px the page shows one column, with a back button on the detail. Light and dark themes follow your system, with a toggle.

Each pipeline's header shows the logo of the agent that runs the pipeline (Claude Code or Codex). Click it to copy the command that reopens the session in its folder. Pipeship stores the harness, the session id, the folder and the T3 Code thread, never a pid or a token.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/dashboard-dark.png">
  <img alt="The pipeship dashboard: the pipelines grouped by status on the left; on the right a pipeline over two repos with its steps, one PR stack per repo and the Test tab" src="docs/dashboard-light.png" width="720">
</picture>

### Actions

The header can request a pipeline stop (the agents stop after their current step), stop the test servers ("Stop preview": a ready pipeline becomes done) and start them again ("Start preview" on a done pipeline, with no confirmation; a failure shows in the Test tab). A pipeline is `ready` while its preview runs and `done` when every step is finished and no preview runs. A done or failed pipeline can be archived ("Archive", with a confirmation): it moves to the collapsed "Archived" group, out of the header count, and cannot be unarchived. A finished pipeline can be deleted: its worktrees and files go, its branches and PRs stay.

The PR stack is always visible, with one row per repo, its path and its merge button. A finished pipeline's PRs merge in two steps, one button at a time. The green "Combine PRs" button merges each PR into the branch below, from the top, so one PR is left. The violet "Merge into <base>" button then squash-merges that PR into the base branch, after a confirmation. Both wait for the checks and stop at the first PR that cannot merge, with the reason in the pipeline's detail. Only one merge runs at a time.

The dashboard also syncs PR statuses with GitHub. At startup, on page load and every 60 seconds, it runs `gh pr view` for each chunk that has a PR and is not merged. It skips pipelines with no such PR, and pipelines while a merge runs. A PR merged elsewhere sets the chunk to `merged`. A PR closed without merge sets it to `closed`, and a reopened PR sets it back to `done`. Without `gh`, or on an error, the state stays as it is and the error goes to `~/.pipeship/dashboard.log`. The merge buttons stay for a closed PR: Combine PRs and Merge then fail with "PR #n is closed". The page-load check runs at most once every 15 seconds. In the pipeline list, a violet merge icon shows that all PRs of a pipeline are merged.

### Test tab

The test URLs, one per service, and the agent's `test.md` guide: the page to open, the steps to follow, what could not be tested. You can test without leaving the dashboard. Code blocks in the guide are highlighted.

### Code tab

The code diff, to review the work without leaving the dashboard.

- **Whole stack** by default: `<base>...<top branch>`, one diff per repo.
- **One PR**: click it in the stack for `<previous branch>...<branch>`. The breadcrumb ("Whole stack › PR #17") or the base branch row brings you back.
- Every file opens as a collapsible block with its line numbers, its +/− counts and syntax highlighting. "Collapse all" and "Expand all" toggle every file; "Refresh" reloads the diff.

Diffs come from the local branches (or `origin/<branch>` when the local one is gone). A missing branch shows a message in its repo's section.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/dashboard-code-dark.png">
  <img alt="The Code tab: the diff of one PR of the stack, with line numbers and syntax highlighting" src="docs/dashboard-code-light.png" width="720">
</picture>

### T3 Code

pipeship recognizes when a session runs in [T3 Code](https://github.com/pingdotgg/t3code). The header then shows a **T3** button next to the agent logo. Click it to open that pipeline's session in the T3 Code desktop app (`t3code://threads/<environmentId>/<threadId>`, T3 Code 0.0.46 or later). Each pipeline opens its own thread, so you can jump from the dashboard to the right conversation.

`pipeship new` finds the thread in T3 Code's local database (`$T3CODE_HOME`, default `~/.t3`), read-only; `pipeship step` looks again until it is found. Without T3 Code, the header has no T3 button and nothing else changes.

### Run it

The pipeline starts the dashboard for you. To start or stop it yourself, use `/pipeship:dashboard` and `/pipeship:dashboard stop` in Claude Code, or `$dashboard` and `$dashboard stop` in Codex (from a terminal: `scripts/pipeship dashboard [stop]`). Stopping it leaves the pipelines and their test servers running.

The page is React, Tailwind and [shadcn/ui](https://ui.shadcn.com) components (`src/dashboard/`). Bun builds it in memory when the dashboard starts: no Vite, no build step.

State lives in `~/.pipeship/pipelines/<id>/` (`state.json`, `ticket.md`, `explore.md`, `plan.md`, `test.md`, worktrees, `preview.log`).

## Develop

```sh
bun test
bun run typecheck
```

To release, bump `version` in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, then push. Users only get an update when the version changes; a test checks that the three files agree.
