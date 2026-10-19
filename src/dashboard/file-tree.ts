import type { DiffFile } from "../diff.ts";

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; file: DiffFile };

// Same id on the section and in the tree click; the repo keeps it unique when several repos share a path.
export const fileDomId = (repo: string, path: string) => `diff:${repo}:${path}`;

// Folders first, then files, each alphabetical.
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
}

// A folder holding only one folder joins it on one line (`src/dashboard`), as on GitHub.
function merge(node: TreeNode): TreeNode {
  if (node.kind === "file") return node;
  let cur = node;
  while (cur.children.length === 1 && cur.children[0]!.kind === "dir") {
    const only = cur.children[0] as typeof cur;
    cur = { ...only, name: `${cur.name}/${only.name}` };
  }
  return { ...cur, children: cur.children.map(merge) };
}

export function buildFileTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, Extract<TreeNode, { kind: "dir" }>>();
  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(path);
      if (!dir) {
        dir = { kind: "dir", name: parts[i]!, path, children: [] };
        dirs.set(path, dir);
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({ kind: "file", name: parts[parts.length - 1]!, path: file.path, file });
  }
  sortNodes(root);
  return root.map(merge);
}
