// Pure unified-diff parser and the HTTP contract of the diff route. No node: imports:
// the browser dashboard imports this file too.

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";
export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string; // without the leading " ", "+" or "-"
  oldNo?: number; // set for context and del
  newNo?: number; // set for context and add
  noNewline?: boolean; // followed by "\ No newline at end of file"
}

export interface DiffHunk {
  header: string; // full "@@ -a,b +c,d @@ section" line
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string; // text after the second "@@", trimmed
  lines: DiffLine[];
}

export interface DiffFile {
  path: string; // display path: newPath, or oldPath when deleted
  oldPath: string; // "" when added
  newPath: string; // "" when deleted
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number; // counted before any truncation
  oldMode?: string;
  newMode?: string;
  similarity?: number; // renames and copies, percent
  truncated?: boolean; // > maxLinesPerFile: hunks dropped, counts kept
  hunks: DiffHunk[];
}

export interface ParseOptions {
  maxLinesPerFile?: number; // default 3000
}

export interface DiffResponse {
  repo: string; // Repo.path
  name: string; // repoName(repo)
  chunk: string | null; // null = whole repo
  from: string; // branch name as given (base or previous chunk branch)
  to: string;
  range: string; // refs actually used, e.g. "main...feat/api" or "origin/main...feat/api"
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean; // raw output went past maxBytes: files after the cut missing
  // Local head against origin/<to>: ahead = not pushed, behind = only on origin.
  // null when the head is read from origin or has no copy there.
  origin: { ahead: number; behind: number } | null;
}

export type DiffErrorCode =
  | "not_found" // 404 unknown pipeline or chunk
  | "bad_request" // 400 repo missing (multi-repo) or unknown
  | "no_branch" // 409 chunk has no branch yet, or no chunk of the repo has one
  | "no_base" // 409 range needs repo.base and it is unset
  | "missing_ref" // 409 branch not in local repo
  | "no_repo" // 409 repo path gone or not a git repo
  | "git_failed"; // 500 git non-zero or timeout

export interface DiffErrorBody {
  error: string;
  code: DiffErrorCode;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// Decodes a C-quoted git path ("a/t\303\251st"); octal escapes are UTF-8 bytes.
function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
    if (oct) {
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      const n = body[++i] ?? "";
      bytes.push(...enc.encode(simple[n] ?? n));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// "--- a/x\t" or "+++ b/x": drops the prefix and the tab git adds after paths with spaces.
function sidePath(raw: string, prefix: string): string {
  const p = unquote(raw.replace(/\t.*$/, ""));
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function headerPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const end = rest.slice(1).search(/(?<!\\)"/) + 2;
    if (end > 1) return [sidePath(rest.slice(0, end), "a/"), sidePath(rest.slice(end).trimStart(), "b/")];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2)) {
    return [sidePath(rest.slice(0, half), "a/"), sidePath(rest.slice(half + 1), "b/")];
  }
  const i = rest.indexOf(" b/");
  return i < 0 ? [rest, rest] : [sidePath(rest.slice(0, i), "a/"), sidePath(rest.slice(i + 1), "b/")];
}

export function parseDiff(text: string, opts: ParseOptions = {}): DiffFile[] {
  const max = opts.maxLinesPerFile ?? 3000;
  const files: DiffFile[] = [];
  try {
    let file: DiffFile | undefined;
    let hdrOld = "";
    let hdrNew = "";
    let hunk: DiffHunk | undefined;
    let oldRem = 0;
    let newRem = 0;
    let oldNo = 0;
    let newNo = 0;
    let last: DiffLine | undefined;
    let shown = 0;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let minusPath: string | undefined; // "" = /dev/null
    let plusPath: string | undefined;

    const finish = () => {
      if (!file) return;
      const f = file;
      const oldP = renameFrom ?? minusPath ?? hdrOld;
      const newP = renameTo ?? plusPath ?? hdrNew;
      if (minusPath === "" && !renameFrom) f.status = "added";
      if (plusPath === "" && !renameTo) f.status = "deleted";
      f.oldPath = f.status === "added" ? "" : oldP;
      f.newPath = f.status === "deleted" ? "" : newP;
      f.path = f.status === "deleted" ? f.oldPath : f.newPath;
      if (shown > max) {
        f.truncated = true;
        f.hunks = [];
      }
      files.push(f);
      file = undefined;
    };

    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git ")) {
        finish();
        [hdrOld, hdrNew] = headerPaths(line.slice(11));
        file = { path: "", oldPath: "", newPath: "", status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
        hunk = undefined;
        last = undefined;
        shown = 0;
        oldRem = newRem = 0;
        renameFrom = renameTo = minusPath = plusPath = undefined;
        continue;
      }
      if (!file) continue;
      const m = HUNK.exec(line);
      if (m) {
        const oldLines = m[2] === undefined ? 1 : Number(m[2]);
        const newLines = m[4] === undefined ? 1 : Number(m[4]);
        hunk = {
          header: line, oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, lines: [],
          ...(m[5]!.trim() && { section: m[5]!.trim() }),
        };
        file.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        oldRem = oldLines;
        newRem = newLines;
        last = undefined;
        continue;
      }
      if (hunk && (oldRem > 0 || newRem > 0)) {
        const c = line[0];
        let dl: DiffLine | undefined;
        if (c === " " && oldRem > 0 && newRem > 0) {
          dl = { kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
          oldRem--;
          newRem--;
        } else if (c === "-" && oldRem > 0) {
          dl = { kind: "del", text: line.slice(1), oldNo: oldNo++ };
          oldRem--;
          file.deletions++;
        } else if (c === "+" && newRem > 0) {
          dl = { kind: "add", text: line.slice(1), newNo: newNo++ };
          newRem--;
          file.additions++;
        }
        if (dl) {
          hunk.lines.push(dl);
          last = dl;
          shown++;
          continue;
        }
      }
      if (line.startsWith("\\") && last) {
        last.noNewline = true;
        continue;
      }
      if (line.startsWith("new file mode ")) {
        file.status = "added";
        file.newMode = line.slice(14).trim();
      } else if (line.startsWith("deleted file mode ")) {
        file.status = "deleted";
        file.oldMode = line.slice(18).trim();
      } else if (line.startsWith("old mode ")) file.oldMode = line.slice(9).trim();
      else if (line.startsWith("new mode ")) file.newMode = line.slice(9).trim();
      else if (line.startsWith("similarity index ")) file.similarity = parseInt(line.slice(17), 10);
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        renameFrom = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10));
      else if (line.startsWith("copy from ")) {
        file.status = "copied";
        renameFrom = unquote(line.slice(10));
      } else if (line.startsWith("copy to ")) renameTo = unquote(line.slice(8));
      else if (line.startsWith("--- ") && !file.hunks.length) {
        const p = line.slice(4);
        minusPath = p.startsWith("/dev/null") ? "" : sidePath(p, "a/");
      } else if (line.startsWith("+++ ") && !file.hunks.length) {
        const p = line.slice(4);
        plusPath = p.startsWith("/dev/null") ? "" : sidePath(p, "b/");
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.binary = true;
        if (/^Binary files \/dev\/null and /.test(line)) file.status = "added";
        else if (/ and \/dev\/null differ$/.test(line)) file.status = "deleted";
      }
    }
    finish();
  } catch {
    // The parser never throws: a bad diff gives the files read so far.
  }
  return files;
}

export function diffTotals(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}
