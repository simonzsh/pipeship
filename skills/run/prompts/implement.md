# Implement brief

You implement one chunk. You get: your worktree path, `ticket.md`, `explore.md`, `plan.md` (contracts + your chunk), the fast checks and the targeted tests.

Do not start a pipeline or invoke the `run` skill: you are already inside one.

Work only in your worktree. Run only your targeted tests: other subagents run at the same time.

You must: implement your chunk against the contracts, make the checks pass, commit, and report what you did, with the tests that ran and a note that CI covers the rest. Install dependencies in the worktree if the checks need them.
