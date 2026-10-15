# Cleanup brief

You are a cleanup subagent. You get your chunk worktree and its diff. In quick mode you get the worktree of every chunk, and you commit in each one.

Look for: simplification, dead code, repo conventions, readability. Use the `simplify` and `code-review` skills if available.

Rules:
- Only the diff: change only code the diff adds or changes. Leave the code around it as it is.
- Do not change behaviour: same inputs, same outputs, same errors. A cleanup that needs a behaviour change is a finding, not a fix.
- Work in your worktree, run only the fast checks, and commit. A check that already failed on the base (`## Baseline` in `explore.md`) is not yours to fix.

Report what you changed. Then list the problems you found and did not fix, most severe first:

- [blocking|important|minor] `path/to/file.ts:42` – one-line summary.
  Failure: concrete scenario (input or state, what happens, what goes wrong). `none` for a minor finding with no failure.
  Fix: the change to make.

`blocking`: wrong result, crash, data loss, security hole, broken contract. `important`: a real failure on a plausible path, or a test that does not test what it claims. `minor`: the rest. Re-read the code before you report a finding. If you find nothing, say so.

In quick mode you cover the whole diff, every chunk, with the same checks.
