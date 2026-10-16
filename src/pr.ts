import { defaultRunner, parsePrUrl, type Runner } from "./merge.ts";
import { chunksOf, repoName, topChunk } from "./repos.ts";
import { readState, upsertChunk, type Chunk, type Repo, type State } from "./state.ts";

export interface PrOptions {
  title?: string;
  body?: string;
}

const RELATED = "## Related PRs";
const PR_URL = /https?:\/\/\S+\/pull\/\d+/;

// git and gh put the cause at the end: the first line of a rejected push is only "To <remote>".
const lastLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");

// One line per chunk up to the top, with its commit subjects: the user reviews commit by commit.
async function chunksSection(run: Runner, s: State, repo: Repo, top: Chunk): Promise<string> {
  // The local base lags behind after a merge on GitHub: start from the remote one.
  const fetch = await run("git", ["fetch", "origin", repo.base!], { cwd: repo.path });
  if (fetch.code !== 0) throw new Error(`git fetch origin ${repo.base} failed: ${lastLines(fetch.stderr)}`);
  const chunks = chunksOf(s, repo.path);
  const lines = ["## Chunks", ""];
  let from = `origin/${repo.base}`;
  for (const c of chunks.slice(0, chunks.indexOf(top) + 1)) {
    if (!c.branch) continue;
    const log = await run("git", ["log", "--reverse", "--format=%s", `${from}..${c.branch}`], { cwd: repo.path });
    from = c.branch;
    const subjects = log.stdout.split("\n").filter(Boolean);
    if (!subjects.length) continue;
    lines.push(`- \`${c.name}\` (\`${c.branch}\`)`);
    for (const subject of subjects) lines.push(`  - ${subject}`);
  }
  return lines.join("\n");
}

// The lease compares with refs/remotes/origin/<branch>, which stays after the branch is deleted on GitHub
// (merged PR): then expect the branch to be absent, else the push is rejected as "stale info".
async function push(run: Runner, cwd: string, branch: string): Promise<void> {
  const remote = await run("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd });
  if (remote.code !== 0 && remote.code !== 2) throw new Error(`git ls-remote origin ${branch} failed: ${lastLines(remote.stderr)}`);
  const lease = remote.code === 2 ? `--force-with-lease=${branch}:` : "--force-with-lease";
  const pushed = await run("git", ["push", lease, "origin", branch], { cwd });
  if (pushed.code !== 0) throw new Error(`git push ${branch} failed: ${lastLines(pushed.stderr)}`);
}

// A crash after `gh pr create` leaves an open PR the state does not know: take it over.
async function createPr(run: Runner, cwd: string, branch: string, args: string[]): Promise<string> {
  const created = await run("gh", ["pr", "create", "--head", branch, ...args], { cwd });
  const text = `${created.stdout}\n${created.stderr}`;
  if (created.code === 0 || !/already exists/.test(text)) {
    const url = created.stdout.match(PR_URL)?.[0];
    if (created.code !== 0 || !url) throw new Error(`gh pr create ${branch} failed: ${lastLines(created.stderr || created.stdout)}`);
    return url;
  }
  const known = text.match(PR_URL)?.[0];
  if (known) return known;
  const list = await run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url"], { cwd });
  const url = list.code === 0 ? (JSON.parse(list.stdout) as { url: string }[])[0]?.url : undefined;
  if (!url) throw new Error(`gh pr create ${branch} failed: ${lastLines(created.stderr)}`);
  return url;
}

// Pushes the top chunk branch of each repo and opens its PR, or only pushes when that PR is still open.
// Returns one line per repo.
export async function openPrs(id: string, opts: PrOptions = {}, run: Runner = defaultRunner): Promise<string[]> {
  const out: string[] = [];
  try {
    return await openAll(id, opts, run, out);
  } catch (err) {
    // The PRs opened before the failure are recorded, but the caller must still see their URLs.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error([...out, message].join("\n"));
  }
}

async function openAll(id: string, opts: PrOptions, run: Runner, out: string[]): Promise<string[]> {
  const s = readState(id);
  const prs: { url: string; body?: string }[] = [];
  const gh = (cwd: string, args: string[]) => run("gh", args, { cwd });
  for (const repo of s.repos) {
    const name = repoName(repo.path);
    const top = topChunk(s, repo.path);
    if (!top?.branch) {
      out.push(`${name}: no chunk branch, skipped`);
      continue;
    }
    if ((await run("git", ["remote", "get-url", "origin"], { cwd: repo.path })).code !== 0) {
      out.push(`${name}: no remote, skipped`);
      continue;
    }
    // With lease: a restack after feedback rewrites the branch, but nobody else's push is lost.
    await push(run, repo.path, top.branch);
    if (top.pr) {
      const view = await gh(repo.path, ["pr", "view", top.pr, "--json", "state"]);
      if (view.code !== 0) throw new Error(`gh pr view ${top.pr} failed: ${lastLines(view.stderr)}`);
      if ((JSON.parse(view.stdout) as { state: string }).state === "OPEN") {
        prs.push({ url: top.pr });
        out.push(`${name}: pushed ${top.branch}, PR already open: ${top.pr}`);
        continue;
      }
    }
    if (!opts.title) throw new Error(`${name}: a new PR needs --title`);
    if (opts.body === undefined) throw new Error(`${name}: a new PR needs --body-file`);
    if (!repo.base) throw new Error(`${name} has no base branch`);
    const body = `${opts.body.trim()}\n\n${await chunksSection(run, s, repo, top)}`;
    const url = await createPr(run, repo.path, top.branch, ["--base", repo.base, "--title", opts.title, "--body", body]);
    // A new URL on a merged or closed chunk sets it back to done (see upsertChunk).
    upsertChunk(id, { name: top.name, pr: url });
    prs.push({ url, body });
    out.push(`${name}: opened ${url}`);
  }
  if (prs.length >= 2 && prs.some((p) => p.body !== undefined)) await linkPrs(s.repos[0]!.path, prs, run);
  return out;
}

// Rewrites the "Related PRs" list of every PR through the REST API: `gh pr edit` fails on some repos.
async function linkPrs(cwd: string, prs: { url: string; body?: string }[], run: Runner): Promise<void> {
  for (const pr of prs) {
    const { owner, repo, number } = parsePrUrl(pr.url);
    const path = `repos/${owner}/${repo}/pulls/${number}`;
    let body = pr.body;
    if (body === undefined) {
      const got = await run("gh", ["api", path, "--jq", '.body // ""'], { cwd });
      if (got.code !== 0) throw new Error(`gh api ${path} failed: ${lastLines(got.stderr)}`);
      body = got.stdout;
    }
    // GitHub stores a body edited on the web with CRLF: the split would miss the old list.
    const kept = body.replace(/\r\n/g, "\n").split(`\n${RELATED}\n`)[0]!.trimEnd();
    const list = prs.filter((o) => o !== pr).map((o) => `- ${o.url}`).join("\n");
    const edit = await run("gh", ["api", "-X", "PATCH", path, "-f", `body=${kept}\n\n${RELATED}\n\n${list}\n`], { cwd });
    if (edit.code !== 0) throw new Error(`gh api PATCH ${path} failed: ${lastLines(edit.stderr)}`);
  }
}
