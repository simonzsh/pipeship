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

Tests first. Write tests before the code, at the test seams of your chunk in `plan.md`. With no `plan.md` (quick mode), pick the public interface yourself, where a test sees behaviour.
- Go one vertical slice at a time: one failing test (red), the code that passes it (green), repeat. Never write all tests first, then all code.
- Test behaviour through the public interface. Do not mock internals, test private functions, or check through a side channel such as the database.
- Do not write tautological tests: compute the expected value on its own, not the way the code does.
- For a bug fix, first write a failing test that reproduces the bug, then fix it.
- If no seam fits (config, docs, pure wiring), say so in your report.

Work only in your worktree. Run only your targeted tests: other subagents run at the same time.

You must: implement your chunk against the contracts, make the checks pass, commit, and report what you did, with the tests written first and the tests that ran and a note that CI covers the rest. Install dependencies in the worktree if the checks need them.
