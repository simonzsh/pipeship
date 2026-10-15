---
name: update
description: Update the pipeship plugin to the latest version, or check whether a newer version exists. Use only when the user asks to update pipeship or to check its version.
argument-hint: "[check]"
---

# pipeship update

Arguments: `$ARGUMENTS` (Claude Code fills them; in Codex, read them from the user's message).

The launcher is `"$(realpath <this skill's base directory>)/../../scripts/pipeship"`. On first use it installs its dependencies, which takes a few seconds.

- **`check`**, or the user only asks which version runs: run `<launcher> update --check`. It prints `current`, `latest` and `available`. Tell the user.
- **No argument**: run `<launcher> update`. It updates the plugin in each harness that installed it (Claude Code, Codex). If the dashboard runs, the dashboard does the update and restarts on the same port. Tell the user what it printed.

If it refuses because a test environment is starting or a merge runs, tell the user to wait and try again. A git checkout is not updated: tell the user to run `git pull`.

The skills of this session stay at the old version. Tell the user to start a new session to load the new skills. Pipelines and their test servers keep running. Do nothing else.
