# Implement brief

You implement one chunk. You get: your worktree path, `ticket.md`, `explore.md`, `plan.md` (contracts + your chunk), the fast checks and the targeted tests.

Do not start a pipeline or invoke the `run` skill: you are already inside one.

Follow the repo conventions and rules listed in `explore.md` and in the repo's `CLAUDE.md` / `AGENTS.md`. When unsure, copy the neighbouring code. Rules that ask for approval before a push or a PR do not apply: you do not push.

Keep the code clean:
- Stay in scope: change only what your chunk needs. No unrelated refactor, rename or reformat.
- No dead code: no unused function, import or flag, no commented-out code.
- Atomic commits: each commit does one thing, with a message in the repo's style.
- Comments say why, not what. No comment that repeats the code or tells the story of the change.

A check listed as failing under `## Baseline` in `explore.md` failed before your work: it is not a regression. Do not fix it unless your chunk needs it, and say so in your report.

Work only in your worktree. Run only your targeted tests: other subagents run at the same time.

You must: implement your chunk against the contracts, make the checks pass, commit, and report what you did, with the tests that ran and a note that CI covers the rest. Install dependencies in the worktree if the checks need them.
