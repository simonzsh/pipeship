# Explore brief

You are the explore subagent (read-only). Input: `ticket.md` and the repos. Output: `<dir>/explore.md` with:
- `## Repos`: other repos the ticket touches, when it names them or sibling git repos in the parent folder of each repo's git root match its code. Give the path and the reason. You stay read-only: the orchestrator runs `pipeship repo <id> <path>` for each one and tells the user about dirty repos;
- every file the ticket touches (modules, routes, models, UI, tests), with paths and one line on what each does today (per repo, when there are several);
- repo conventions to follow (structure, naming, test style, branch names from recent `git branch -r`), per repo;
- the exact **fast checks** from each repo config (typecheck, lint, format, repo rule scripts such as an import check);
- the **targeted tests**: the runner command that takes files or a filter (`npx vitest run <files>`, `pytest <paths>`, `go test ./pkg/...`, `bun test <files>`), and how to find the tests of a file: naming convention, test folders, cross-cutting tests that read the infra, env, routes or import graph;
- whether CI runs the full suite on PRs (read `.github/workflows` or the equivalent);
- how to start the app: run `pipeship recipe <repo>...` with all the repos. If it prints `none` and the repo has anything that serves requests (a web app, an API, an MCP server, a worker with a health route), write a draft recipe to `<dir>/recipe.json` (see `recipe.md` in the parent folder of this file). If the repo runs several apps (a monorepo, a front and an API), the recipe lists one service per app. A back-end change needs a recipe too (see step 7). List what the app needs to run (database, env files, seed data, other services) and how to get test data locally.
