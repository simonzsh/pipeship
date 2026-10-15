# Test environment recipe

This is the recipe format used by `pipeship preview`. It is read at step 7, and by the explore brief when it drafts a recipe.

You write the recipe. Read `package.json`, the lock file, the README and the dev scripts to find the package manager, the dev command and how the app picks its port. A `.pipeship.json` at the repo root, if the team shares one, wins over the saved recipe.

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
- Every service is served as `http://localhost:<port>`. Leave the repo's config as it is: the recipe adapts to the repo.

## Several services

For a monorepo or a front with its own API, list one service per app. `install` and `copyFiles` stay at the top level. With `services`, each service has its own `start` and the top level has none.

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
- Start each app with its own command that takes the port, rather than the repo's global dev command (`turbo dev`, a root `pnpm dev`), which starts apps on fixed ports.
- A service gets another service's URL through `env`: `"API_URL": "http://localhost:${api.port}"`.
- pipeship picks every port first: fronts from 3000, other kinds from 4000 (4400 is skipped).
- Back ends and other kinds start first, then fronts. Each service must answer on its `readyPath` before the next one starts. A status below 500 is ready (a 404 counts); a 5xx, such as a compile error page, is not. `"ready": "tcp"` only waits for a connection to its port (for a database or queue).
- If a port truly cannot be set, write `"fixedPort": <port>`. pipeship then refuses to start a second pipeline that shares a repo while one runs.

## A database per pipeline

Previews of a repo share its local database by default. To give each pipeline its own, name the database after the pipeline with `${pipeline.id}` in `env`, and create it in `start`:

```json
{
  "services": [
    { "name": "app", "kind": "front",
      "start": "createdb \"$DB_NAME\" 2>/dev/null; bun run db:migrate && bun run dev",
      "env": { "DB_NAME": "app_${pipeline.id}", "DATABASE_URL": "postgres://localhost:5432/app_${pipeline.id}" } }
  ]
}
```

- `${pipeline.id}` works in every `env` value. The id has lowercase letters, digits and `-`: quote it in SQL.
- `env` is set per service: for one app, write `services` with one service.
- `start` creates the database when it is missing and keeps it when it exists. Seed it there if the app needs data.
- pipeship does not drop it: drop it by hand (`dropdb`) once the pipeline is done.

## Several repos

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
- Put `install` and `copyFiles` on each service.
- The recipe is saved for this set of repos.
