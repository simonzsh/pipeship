import { defaultRunner, parsePrUrl, type Runner } from "./merge.ts";
import { chunksOf, diffRange, repoName, topChunk } from "./repos.ts";
import { readState, upsertChunk, type Chunk, type Repo, type State } from "./state.ts";

export interface PrOptions {
  title?: string;
  body?: string;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
const RELATED = "## Related PRs";

// One line per chunk up to the top, with its commit subjects: the user reviews commit by commit.
async function chunksSection(run: Runner, s: State, repo: Repo, top: Chunk): Promise<string> {
  const chunks = chunksOf(s, repo.path);
  const lines = ["## Chunks", ""];
  for (const c of chunks.slice(0, chunks.indexOf(top) + 1)) {
    const range = diffRange(s, repo, c.name);
    if ("error" in range) continue;
    const log = await run("git", ["log", "--reverse", "--format=%s", `${range.from}..${range.to}`], { cwd: repo.path });
    lines.push(`- \`${c.name}\` (\`${c.branch}\`)`);
    for (const subject of log.stdout.split("\n").filter(Boolean)) lines.push(`  - ${subject}`);
  }
  return lines.join("\n");
}

// Pushes the top chunk branch of each repo and opens its PR, or only pushes when that PR is still open.
// Returns one line per repo.
export async function openPrs(id: string, opts: PrOptions = {}, run: Runner = defaultRunner): Promise<string[]> {
  const s = readState(id);
  const out: string[] = [];
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
    const push = await run("git", ["push", "--force-with-lease", "origin", top.branch], { cwd: repo.path });
    if (push.code !== 0) throw new Error(`git push ${top.branch} failed: ${firstLine(push.stderr)}`);
    if (top.pr) {
      const view = await gh(repo.path, ["pr", "view", top.pr, "--json", "state"]);
      if (view.code !== 0) throw new Error(`gh pr view ${top.pr} failed: ${firstLine(view.stderr)}`);
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
    const created = await gh(repo.path, ["pr", "create", "--head", top.branch, "--base", repo.base, "--title", opts.title, "--body", body]);
    const url = created.stdout.match(/https?:\/\/\S+\/pull\/\d+/)?.[0];
    if (created.code !== 0 || !url) throw new Error(`gh pr create ${top.branch} failed: ${firstLine(created.stderr || created.stdout)}`);
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
      if (got.code !== 0) throw new Error(`gh api ${path} failed: ${firstLine(got.stderr)}`);
      body = got.stdout;
    }
    const kept = body.split(`\n${RELATED}\n`)[0]!.trimEnd();
    const list = prs.filter((o) => o !== pr).map((o) => `- ${o.url}`).join("\n");
    const edit = await run("gh", ["api", "-X", "PATCH", path, "-f", `body=${kept}\n\n${RELATED}\n\n${list}\n`], { cwd });
    if (edit.code !== 0) throw new Error(`gh api PATCH ${path} failed: ${firstLine(edit.stderr)}`);
  }
}
