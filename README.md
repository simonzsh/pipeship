# pipeship

Feature pipeline for Claude Code. Give it a ticket or an issue from any source; it maps the code, asks its questions in one batch, plans, implements chunks in parallel worktrees, cleans up the code, opens stacked PRs, and starts the app so you can test it at a URL.

```
/pipeship ABC-123
/pipeship quick https://github.com/org/repo/issues/42
/pipeship --skip questions,stack "Add a date filter to the orders page"
```

Modes: `full` (default, all 7 steps) and `quick` (one chunk, blocking questions only). `--skip` removes steps; you can also say "skip the review" during the run.

## Install

Requires [Bun](https://bun.sh), git and `gh`. From the repo root, link the skill into your Claude Code skills:

```sh
ln -s "$PWD/skills/pipeship" ~/.claude/skills/pipeship
```

There is no build and no runtime dependency: the skill runs `src/cli.ts` from this repo, so changes apply at once. `bun install` is only needed to develop (see below).

The skill runs when you type `/pipeship`, or when you explicitly ask Claude to use pipeship ("ship ABC-123 with pipeship"). Claude does not start it for ordinary feature requests.

## Test environment

Add `.pipeship.json` at the root of each repo (the pipeline offers one if it is missing):

```json
{ "install": "bun install", "start": "bun run dev", "portEnv": "PORT", "copyFiles": [".env.local"], "readyPath": "/" }
```

The app runs on a free port from 3100, at `http://<ticket>.localhost:<port>`.

## Dashboard

`bun src/cli.ts dashboard` starts it in the background on http://localhost:4400 (the skill does it for you). It lists pipelines live, with their steps, PRs and test URL, and a "Stop pipeline" button. Stop the dashboard with `bun src/cli.ts dashboard stop`.

State lives in `~/.pipeship/pipelines/<id>/` (`state.json`, `ticket.md`, `map.md`, `plan.md`, worktrees, `preview.log`).

## Develop

```sh
bun install
bun test
bun run typecheck
```
