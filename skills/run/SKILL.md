---
name: run
description: Feature pipeline from a work request to one PR per repo and a running test environment. Use whenever the user asks to make, fix, build or change something, with or without a ticket: a ticket reference (ABC-123), a Linear/Notion/GitHub/Jira URL, a ticket text, or a task decided after a discussion. Use it only for a code change big enough for a branch and a pull request. Do not use it for a one-line tweak, a config or file edit, a chart or document, or a task that needs no pull request. Never use it for a question, an explanation, a plain discussion, a review or a status request.
argument-hint: "[quick|full] [--skip step,step] <ticket ref, URL or text, or the work request>"
---

# pipeship

Run the pipeline below on the user's ticket: `$ARGUMENTS`

In this skill, "ticket" means the ticket, or the work request when there is no ticket. Then `ticket.md` holds the request and the decisions of the discussion.

You are the orchestrator. Run each heavy step in a subagent with a clean context. Each step writes its result to a file in the pipeline directory; the next step reads that file. Keep the user's session for decisions and questions only.

## Claude Code and Codex

This skill runs in both. Where they differ:
- **Arguments**: Claude Code fills `$ARGUMENTS`. Codex leaves it as is: take the ticket and the options from the user's message.
- **Subagents**: use your harness's subagent tool (Claude Code: `Agent`; Codex: spawn sub-agents). To run subagents in parallel, start them together. If you have none, run the step yourself.
- **Models**: `opus` and `sonnet` below are Claude Code model names. In another harness, use your strongest model for `opus` steps and your default model for `sonnet` steps.
- **Codex sandbox**: pipeship writes outside the repo (`~/.pipeship`), starts background servers and pushes branches. If the sandbox blocks a command, ask the user to approve it or to relax the sandbox.

## Helper

`pipeship` below means `"$(realpath <this skill's base directory>)/../../scripts/pipeship"` (`realpath` matters when the skill is a symlink). On first use it installs its dependencies, which takes a few seconds. It owns the state file `~/.pipeship/pipelines/<id>/state.json`, which the dashboard displays: the user follows the pipeline there.

`<skill dir>` below means `$(realpath <this skill's base directory>)`. Next to this file: `recipe.md` (recipe format) and `prompts/<name>.md` (subagent briefs: `explore`, `plan`, `implement`, `global-review`, `cleanup`). Do not confuse `<skill dir>/recipe.md` (format doc) with `<dir>/recipe.json` (draft recipe).

```
pipeship new [--repo <path>]... --title <t> [--source <s>] [--ref <r> --url <u>]... [--name <words>] [--mode quick] [--skip a,b]
pipeship repo <id> <path>              # add a repo to the pipeline (once per repo); prints its base and whether it is dirty
pipeship get <id>                      # read state: check stopRequested and skipped steps
pipeship step <id> <step> running|done|skipped|failed   # running|done|failed need every earlier step done or skipped
pipeship mode <id> quick|full         # switch the mode after creation; quick skips the pending plan step
pipeship wait <id> <step> [--reason <question>]   # pause for the user on this step: the step runs, the card shows the question
pipeship archive <id>                            # done, failed or stopped only; the user archives, not the agent
pipeship unarchive <id>                          # archived only; the user unarchives (dashboard or this command)
pipeship chunk <id> <name> [--repo r] [--worktree p] [--branch b] [--status s] [--pr url]   # --repo (name or path) needed for a new chunk with several repos
pipeship pr <id> [--title <t>] [--body-file <file>]   # per repo: push the top chunk branch, open its PR (or only push if it is open), print the URLs
pipeship recipe <repo>...              # the saved recipe to start the app for these repos, or "none"
pipeship preview <id> [<worktree>] [--recipe file]   # starts the app, prints the URL(s); each service runs from the top worktree of its repo
pipeship dashboard                     # starts the dashboard if needed, prints its URL
```

Steps: `explore`, `questions`, `plan`, `implement`, `review`, `preview`.

## Rules

- **Brief each subagent with its prompt file**: tell it to read `<skill dir>/prompts/<name>.md` first, then give it its inputs. Pass absolute paths (the brief, `<dir>`, its worktree, and the `pipeship` helper when the brief uses it): a subagent does not know the skill dir. When you run a step yourself (quick explore, no subagent tool), read the brief and follow it.
- **Each step**: `pipeship step <id> <step> running` when it starts, `done` when it ends.
- **Each chunk**: set it to its activity (`coding`, `reviewing`, `fixing`) when its subagent starts. When that subagent reports, set the chunk to `done` (`failed` if it failed) at once, while the other subagents still run. The user follows each chunk live in the dashboard.
- **Before each step**, run `pipeship get <id>`. If `stopRequested` is true, stop and tell the user, unless the user just asked you to resume. If the step is `skipped`, move on.
- **The user can change the steps at any time** ("skip the review", "ask me your questions anyway"). Update the state with `pipeship step <id> <step> skipped|pending` and continue.
- **Steps run in order.** `step ... running|done|failed` and `wait` are refused while an earlier step is not `done` or `skipped`; the error names it. To move past a step, mark it `skipped` (the user's choice). `pending` and `skipped` are always allowed, so reopening an earlier step works. A step set back to `pending` must be `done` or `skipped` again before a later step can be marked.
- **Keep the steps that later steps need**: the test environment needs a worktree; PRs need commits. A skipped `review` does not skip the PRs: run `pipeship pr` anyway (see step 5), unless the user does not want PRs.
- On failure: `pipeship step <id> <step> failed`, explain what failed, and ask the user what to do.
- **The checks** are the **fast checks** (typecheck, lint, format, repo rule scripts: they run in full) plus the **targeted tests** for the diff: test files added or changed, tests of the changed modules, and cross-cutting tests the diff can break (infra, env, routes, imports). Do not run the full suite: CI runs it on each PR. Exception: if CI does not run the full suite on PRs, or the user asks for it, run it once only, on the top of each repo, at the end of step 5, before `pipeship pr`.
- **Report the tests.** Every report that mentions checks lists the tests that ran and says that CI covers the rest. If the full suite ran locally instead, say so.
- **One test suite at a time on the machine.** Never run two suites in parallel (several subagents, several worktrees). Subagents that run together run only their targeted tests.
- **Every pause for the user names its step**: `pipeship wait <id> <step> --reason "<the question, in one short line>"`, then stop. This covers the questions of step 2 and any decision you cannot make. The step shows amber on the dashboard and the card shows the question. When the user answers, the next `step` call ends the wait.
- **Within a step that needs a decision, do the work that does not depend on it first, then run `wait` last and ask once.** Later steps are refused until this step is done or skipped.
- While this pipeline runs, it replaces process skills such as brainstorming, writing-plans, using-git-worktrees, subagent-driven-development and finishing-a-development-branch. The only skills it uses are `simplify` and `code-review`, in step 5.
- If the dashboard shows *Agent stopped*, the user can resume with the command copied from the agent logo in the pipeline header, then continue from the first step that is not done or skipped (`pipeship get <id>`). Marking that step `running` clears `stopRequested`.
- To resume an archived pipeline, mark the step you reopen `running`: that unarchives it. Never archive or unarchive it yourself. For feedback after the end, see **Feedback after the pipeline**.
- Stop every server you start outside `pipeship preview` before you finish: note its PID and run `kill <PID>`.

## Step 0 — Start

1. Parse the arguments: an optional mode (`quick` or `full`, default `full`), an optional `--skip a,b`, and the ticket (reference, URL or text) or the work request. If `$ARGUMENTS` is empty or was not replaced, read the user's message: a ticket reference or URL in it is a ticket (read it as in 0.2); otherwise the message plus what the discussion decided is the work request.
2. **Read the ticket** with whatever tool this session has for its source: an MCP server (Linear, Notion, Jira…), `gh issue view`, or fetching the URL. Plain text is the ticket itself, and a work request without a ticket is the ticket itself: there is nothing to read. A bare reference like `ABC-123` does not name its source: infer it from the tools you have, and ask if unsure. If no tool can read the source, ask the user to paste the ticket.
3. The repos are the git root of the current directory, plus any repo the user names. If the current directory is not in a git repo, run `new` without `--repo`: the explore step adds the repos. The base branch of each repo is its current branch.
4. `pipeship new ...` with one `--repo <path>` per repo, the ticket title (for a work request, a short title), the source (`linear`, `notion`, `github`, `jira`, `url`…; omit `--source` for a plain-text ticket or a work request), and one `--ref`/`--url` pair per ticket when the pipeline covers several. `new --repo` and `repo` reduce a path to its git root and refuse a path outside git. Note the `id` and `dir` it prints. It lists each repo with its `base` and `dirty`: tell the user about dirty repos, because their uncommitted changes will not be in the worktrees. Run `pipeship new` from this orchestrator session: it records the session that runs it (harness, id, cwd).
   - For a plain-text ticket or a work request, pick a 2 or 3 word name that sums it up (`session-link`, `quick-mode`) and pass it with `--name`. Ticket refs win over the name.
5. Write the full ticket text to `<dir>/ticket.md`. For a work request, write a summary instead: the request, the decisions and constraints of the discussion, and what is out of scope. Later steps read only this file.
6. Run `pipeship dashboard` and give the user the URL.

## Step 1 — explore

Subagent (read-only, model `sonnet`; Claude Code: `Explore` type). Input: `ticket.md` and the repos. Output: `<dir>/explore.md`. Brief: `<skill dir>/prompts/explore.md`.

For each repo listed under `## Repos`, run `pipeship repo <id> <path>` and tell the user about dirty repos.

In `quick` mode, read the brief and do the exploration yourself in the main session: on a small ticket a subagent costs as much as the work. Keep `explore.md` short: only the files to change, the fast checks, the targeted tests and how to start the app.

## Step 2 — questions (human pause)

1. Compare `ticket.md` with `explore.md`. List what is missing or ambiguous. With several repos, ask the user to confirm the repo list. The plan and the chunks start only once the list is fixed.
2. Ask **all questions in one batch**, numbered. Format: "Today the code does X. Question: … Recommended: …". The user answers in one word or corrects.
3. In `full` mode, if the ticket is small (one coherent change), also propose switching to `quick`. When the user accepts, run `pipeship mode <id> quick` so the dashboard shows the badge.
4. `pipeship wait <id> questions --reason "<n> questions to answer"`, then **stop and wait** for the answers.
5. When the user answers: append the answers to `ticket.md` under `## Answers`, then `pipeship step <id> questions done`.

In `quick` mode, ask only **blocking** questions. When the explore step added repos, the repo list is a blocking question. If there are none, mark the step done and continue without a pause.

## Step 3 — plan

Subagent (model `opus`; Claude Code: `Plan` type). Input: `ticket.md`, `explore.md`. Output: `<dir>/plan.md`. Brief: `<skill dir>/prompts/plan.md`.

When this step is skipped (`quick` mode), there is one chunk named after the ticket, and the plan is the ticket. With several repos, there is one chunk per repo, named after the repo's folder, and one PR per repo.

## Step 4 — implement

For each chunk, in stack order:
1. Branch `<ticket>/<chunk>`, worktree `<dir>/worktrees/<chunk>`:
   `git -C <chunk's repo> worktree add <dir>/worktrees/<chunk> -b <ticket>/<chunk> <that repo's base>`
   - `<ticket>` is the first ticket ref in lowercase (`abc-123`), or the 2 or 3 word `--name` for a plain-text ticket or a work request. Keep chunk names short too (`api`, `ui`, `backfill`): e.g. `abc-123/api`.
   - If the repo has a branch naming convention (see `explore.md`), follow it instead, e.g. `feat/abc-123-api`.
   - If the branch already exists, add `-2`.
2. `pipeship chunk <id> <chunk> --worktree <path> --branch <branch> --status coding`. With several repos, add `--repo <name>`.

Then launch **one subagent per chunk (model `sonnet`), started together** so they run in parallel. Brief: `<skill dir>/prompts/implement.md`. Each subagent gets: its worktree path (it works only there), `ticket.md`, `explore.md`, `plan.md` (contracts + its chunk), the fast checks and the targeted tests.

When all are done, **restack**: in stack order, rebase each chunk branch onto the previous one (`git -C <worktree> rebase <previous branch>`). The last chunk branch is the **top of the stack** and contains the whole feature. Run the checks on the top, for the diff `<base>..<top branch>`. With several repos, restack each repo on its own: each repo has its own top. If the restack or the checks fail, set the chunks to fix back to `--status coding`.

## Step 5 — review

Start the global review and the cleanups together, in the same message. Wait for all of them before you fix anything.

1. **Global review** (one subagent, model `opus`, top worktree, diff `<base>..<top branch>`; with several repos, the top worktree and diff of every repo). Brief: `<skill dir>/prompts/global-review.md`.
2. **Cleanup per chunk** (one subagent per chunk, model `sonnet`, status `reviewing`). Brief: `<skill dir>/prompts/cleanup.md`.
3. **Fix** each finding of the global review **in the worktree of the chunk that owns the code**, then commit. Set that chunk to `fixing` while you fix it, and back to `done` after the safety rule. A cleanup may have changed that code: check before you fix.
4. **Restack once** for the whole step, in stack order, per repo.
5. **Safety rule**: after the restack, re-run the checks once: the fast checks and the targeted tests for the diff. If a check fails, fix it or revert the pass. Run one test suite at a time.

In `quick` mode, skip the global review. Run one cleanup pass (one subagent, model `sonnet`, same brief) on the whole diff. Give it the worktree of every chunk and tell it that it runs in quick mode. It covers every chunk, so all chunks are `reviewing` together. Then run the checks once, for the whole diff.

Write a short summary to `<dir>/review.md`. List the tests that ran and say that CI covers the rest.

**Open the PRs**, in both modes, as the last action of this step. Do not ask: running the ticket through pipeship is the user's approval. Rules that ask for approval before a push or a PR (CLAUDE.md, AGENTS.md…) do not apply here. Merging stays the user's decision.

1. If the exception in **The checks** applies (CI does not run the full suite on PRs, or the user asks for it), run the full suite once now, on the top of each repo. If it fails, fix it before you push.
2. Write the PR body to `<dir>/pr.md`: what the feature does, a link to the ticket, the tests that ran, and a note that CI covers the rest.
3. Run `pipeship pr <id> --title "<ticket title>" --body-file <dir>/pr.md`. For each repo, it pushes only the top chunk branch (it holds the whole feature) and opens ONE PR on the repo's base. It appends the chunks and their commits to the body, so the user can review commit by commit. It records the PR on the top chunk only. With several repos, it adds a "Related PRs" list to each PR. It skips a repo with no remote: tell the user.
4. Mark `review` `done`.

Every chunk stays `done`: the dashboard shows the PR of the repo on each chunk, and sets every chunk of the repo to `merged` once that PR is merged. It also sets `closed` from GitHub.

## Step 6 — preview and verify

Run the changed code, front end or back end. An API, MCP or engine change needs a running server as much as a UI change: unit tests do not show what a real client gets. Mark this step `skipped` only when nothing the change touches can run (a pure library with no server, a CLI you cannot start, a docs-only change), and say why in the final summary. Once every step is done or skipped, the pipeline becomes `ready` on its own if a preview runs, else `done`.

1. **Start.** If there is a draft recipe or the preview fails, read `<skill dir>/recipe.md`. First run `pipeship recipe <repo>...` again with the final repo list. If the list changed since step 1, update the `repo` names in the draft. Then run `pipeship preview <id>`. It uses each repo's top worktree. Add `--recipe <dir>/recipe.json` if there is a draft. It copies local files, installs, starts each service of the recipe on its own free port (back ends first, then fronts), waits until each answers, and marks the `preview` step done. A draft recipe that works is saved, so later pipelines in this repo skip this work. Give the user the URLs it prints (the first is the main front).
   Services the app needs (a local database, a queue) belong in a `start` command of the recipe, so the dashboard's "Stop preview" button stops them with the app (see `<skill dir>/recipe.md`). Run other one-off setup yourself; for test data, see **Data** below.
2. **Verify.** Use the changed behaviour the way its client does, and write what you called and what came back to `<dir>/verify.md`: a UI change in a browser (the preview tools of your harness), an HTTP API with `curl`, an MCP or other protocol with a real client. Cover the main path and one failure path. If you cannot exercise it (no test data, a missing service), say so in the summary. Report as working only what you exercised.
3. **Fix.** If verification fails, fix the code in the worktree of the chunk that owns it, commit, restack and re-run the checks for the diff of the fix. If step 5 opened PRs, run `pipeship pr <id>` again: it pushes the top branch of each repo.
4. **Test guide.** After verify, write `<dir>/test.md` for the user, in the user's language. The dashboard shows it in the pipeline's Test tab, so the user can test without leaving the dashboard. `verify.md` stays your evidence; `test.md` is the user's guide. Keep it short:
   - the direct URL of the changed page, not only the root;
   - how to log in if the app needs it: which local account, and where its credentials live;
   - 3 to 5 steps, each with its expected result;
   - what you could not test, and why.

Rules for verify and the test guide:
- **Data.** Use the data already there. Create data only in a local database, and list it in the guide. If the database is not local, create nothing and say so in the guide.
- **Local effects only.** When the feature sends an SMS, an email or a payment, or calls a real third-party service, leave that part to the user: mark it "to test by hand" in the guide and explain how.

If the preview fails to start, it prints the log tail: diagnose, fix the recipe or the code, and retry up to twice before asking the user. To fix the recipe: if `pipeship recipe <repo>` points to a `.pipeship.json` in the repo, fix that file in the top worktree (it will be part of the PRs) and tell the user; otherwise write a fixed draft and pass it with `--recipe`. With several repos there is no `.pipeship.json`: fix the saved recipe with a new draft passed with `--recipe`.

## End

Give the user a short summary: the test URL, the PR of each repo, what the verification covered (or why it was skipped), the tests that ran (CI covers the rest), and anything to check by hand. Point to the test guide: the user finds it in the pipeline's Test tab. The test servers keep running on purpose; the user stops them with the dashboard's "Stop preview" button and starts them again with "Start preview".

## Feedback after the pipeline

The user may ask for changes after the end, or comment on a PR. Do not fix it alone with no state. Route it through implement and review.

1. **Same work or new work.** A change to the same work reopens the pipeline: `pipeship step <id> implement running` (it unarchives and clears the stop request). Set each chunk concerned to `pipeship chunk <id> <chunk> --status coding`. Unrelated work is a new pipeline.
2. **Record it.** Add the feedback to `<dir>/ticket.md` under `## Feedback <n>`. The subagents read only this file.
3. **Implement.** One subagent per chunk concerned (model `sonnet`), in its existing worktree. Brief: `<skill dir>/prompts/implement.md`. Give it the feedback. It fixes and commits.
4. **Restack once**, in stack order, then run the targeted checks for the diff of the feedback. Mark `implement` `done`.
5. **Review the delta only.** Mark `review` `running`. Run one cleanup subagent (model `sonnet`, brief `<skill dir>/prompts/cleanup.md`, chunks `reviewing`) on the diff of the feedback. Run the global review (model `opus`, brief `<skill dir>/prompts/global-review.md`) only if the feedback touches several chunks or a contract. Then mark `review` `done`.
6. **Push.** Run `pipeship pr <id>` again. It pushes the top branch of each repo with `--force-with-lease`, so a restack is safe, and an open PR updates on its own. If a PR is merged or closed, it opens a new PR on the base of the repo: pass `--title` and `--body-file` again. It records the new PR on the top chunk and sets that chunk back to `done`, so the dashboard polls and merges it.
7. **Small feedback** (one line, a name, a text): you may fix it yourself. Commit in the chunk that owns the code, restack, re-run the checks, and update the steps.
8. **Test again.** If the tested behaviour changed, run `pipeship preview <id>` again and update `<dir>/verify.md` and `<dir>/test.md`.
