---
name: review
description: Review only of a PR (number or URL), a branch or the current diff, with pipeship's global review and cleanup briefs; returns a ranked list of real problems. Use only when the user explicitly asks for a review. Never use it to implement, fix or change code, nor for a ticket or a work request.
argument-hint: "[<PR number or URL> | <branch>]  (empty: the current diff)"
---

# pipeship review

Review the user's target and report real problems: `$ARGUMENTS`

You are the orchestrator. You change nothing: no code, no commit, no push, no PR comment. Run the two review subagents together, check their findings, and give the user a ranked list.

## Claude Code and Codex

This skill runs in both. Where they differ:
- **Arguments**: Claude Code fills `$ARGUMENTS`. Codex leaves it as is: take the target from the user's message.
- **Subagents**: use your harness's subagent tool (Claude Code: `Agent`; Codex: spawn sub-agents). To run subagents in parallel, start them together. If you have none, run the two reviews yourself, one after the other.
- **Models**: `opus` and `sonnet` below are Claude Code model names. In another harness, use your strongest model for `opus` and your default model for `sonnet`.
- **Read only**: this skill only reads. It needs no write access, except for the temporary worktree of a PR or branch (see **Target**).

## Paths

`<skill dir>` below means `$(realpath <this skill's base directory>)`. `<run dir>` means `$(realpath <skill dir>/../run)`: the `run` skill ships next to this one, and its briefs are `<run dir>/prompts/global-review.md` and `<run dir>/prompts/cleanup.md`. Read them in place and do not copy them. Pass absolute paths to each subagent (the brief, the worktree, the diff command): a subagent does not know the skill dir. If `<run dir>/prompts` does not exist, stop and tell the user that `review` needs the `run` skill installed or linked next to it.

## Rules

- No `pipeship new`, no state file, no dashboard. This is not a pipeline.
- No code change, no push, no PR comment, unless the user explicitly asks. If the user then asks for fixes, suggest the `run` skill.
- Do not run `simplify`: it applies its fixes.
- Stop every server or process you start: note its PID and run `kill <PID>`.

## Step 1 — Target

Find the worktree and the diff to review. Work in the main worktree for the git commands below. `<base>` is the default branch of the repo (`git symbolic-ref --short refs/remotes/origin/HEAD`, without `origin/`), unless the user names another one. Always fetch it first (`git fetch origin <base>`) and use `origin/<base>`, never the local branch.

- **PR** (a number or a URL): run `gh pr view <n|url> --json baseRefName,headRefName,url`. Check that the repo in `url` matches `git remote get-url origin`. If the PR belongs to another repo, tell the user and stop. Use its `baseRefName` as `<base>`. Run `git fetch origin pull/<n>/head`, then `git rev-parse FETCH_HEAD` once and keep that SHA as `<sha>`. `FETCH_HEAD` is per worktree: never give the name `FETCH_HEAD` to a subagent.
- **Branch**: `<sha>` is `git rev-parse <branch>` (or `origin/<branch>` if there is no local branch).
- **PR or branch diff**: `git diff $(git merge-base origin/<base> <sha>)..<sha>`. Give subagents this command with the SHA in it. If the head branch is checked out in a worktree and its HEAD equals `<sha>`, review in that worktree. Otherwise review in a detached temporary worktree at `<sha>`.
- **Nothing given**: the current worktree. The diff is `git diff $(git merge-base origin/<base> HEAD)`, which includes the uncommitted changes. List the untracked files with `git ls-files --others --exclude-standard`, and tell the subagents to read them too.

If the diff is empty, say so and stop. Do this check before you create any worktree. Create a temporary worktree only after it, under `$(mktemp -d)` (`git worktree add --detach <dir> <sha>`). Remove it (`git worktree remove --force <dir>`, then the temporary directory) on every exit: empty diff, error and end.

Tell the user the target in one line (PR, branch or current diff, and the base).

## Step 2 — Review

Start both subagents together, in the same message. Wait for both before you go on.

1. **Global review** (model `opus`, read-only). Input: the worktree and the diff command, as absolute paths. Brief: `<run dir>/prompts/global-review.md`. The brief is read-only already. Add to the brief, word for word:

> Review mode: the diff is one change, not several chunks. Besides the problems in the brief, look for every correctness bug in the diff: logic errors, edge cases, regressions, missing error handling, and tests that do not test what they claim. Each finding needs a failure scenario.
2. **Cleanup** (model `sonnet`). Input: the worktree and the diff command, as absolute paths. Brief: `<run dir>/prompts/cleanup.md`. Pass this rule to the subagent, word for word:

> Review mode: report your findings only. Do not edit, stage or commit any file, and run no command that changes the worktree. This overrides the brief's instruction to commit. Do not run `simplify` (it applies its fixes); `code-review` without `--fix` is fine.

Tell each subagent to give every finding as `file:line`, with the scenario in which it fails.

## Step 3 — Verify and answer

1. Merge both reports and drop the duplicates.
2. Re-read the code of each finding. Drop the false positives, and the findings with no concrete failure.
3. Rank the real problems, most severe first. Keep style and simplification points apart, as cleanups.
4. Remove the temporary worktree, if you made one (also on any earlier exit).

Answer in this shape:

```
## Problems (ranked, most severe first)
1. `path/to/file.ts:42` – one-line summary.
   Failure: concrete scenario (input or state, what happens, what goes wrong).
## Cleanups (optional)
- `path/to/file.ts:88` – suggestion (no failure scenario needed).

Nothing was changed, committed, pushed or commented.
```

If you find nothing real, say so plainly. Do not invent problems to fill the list.
