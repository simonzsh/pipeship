---
name: dashboard
description: Start or stop the shipflow dashboard. Run only when the user asks for it.
argument-hint: "[stop]"
disable-model-invocation: true
---

# shipflow dashboard

Arguments: `$ARGUMENTS` (Claude Code fills them; in Codex, read them from the user's message).

The launcher is `"$(realpath <this skill's base directory>)/../../scripts/shipflow"`. On first use it installs its dependencies, which takes a few seconds.

- **No argument, or `start`**: run `<launcher> dashboard`. It starts the dashboard in the background if it is not running, and prints its URL. Give the user the URL.
- **`stop`**: run `<launcher> dashboard stop` and tell the user what it printed.

Stopping the dashboard does not stop the pipelines or their test servers. Do nothing else.
