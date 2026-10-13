import { createElement, type ReactNode } from "react";
import { common, createLowlight } from "lowlight";
import rehypeHighlight from "rehype-highlight";

export const lowlight = createLowlight(common);

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", php: "php", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql", graphql: "graphql",
  diff: "diff", patch: "diff", lua: "lua", pl: "perl", r: "r", mk: "makefile",
};
const BY_NAME: Record<string, string> = { dockerfile: "bash", makefile: "makefile" };

export function languageOf(path: string): string | undefined {
  const file = (path.split("/").pop() ?? "").toLowerCase();
  const dot = file.lastIndexOf(".");
  const lang = BY_NAME[file] ?? (dot >= 0 ? BY_EXT[file.slice(dot + 1)] : undefined);
  return lang && lowlight.registered(lang) ? lang : undefined;
}

type HNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: HNode[];
};

// Flatten the tree into lines: a token spanning several lines is cloned on each one, keeping its class.
function splitLines(nodes: HNode[]): HNode[][] {
  const lines: HNode[][] = [[]];
  const walk = (node: HNode, wrap: HNode[]) => {
    if (node.type === "text") {
      node.value?.split("\n").forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (!part) return;
        let leaf: HNode = { type: "text", value: part };
        for (const w of wrap.toReversed()) leaf = { ...w, children: [leaf] };
        lines[lines.length - 1]!.push(leaf);
      });
    } else if (node.type === "element") {
      for (const c of node.children ?? []) walk(c, [...wrap, node]);
    }
  };
  nodes.forEach((n) => walk(n, []));
  return lines;
}

function renderHast(node: HNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  const className = node.properties?.className?.join(" ");
  return createElement(node.tagName ?? "span", { key, className }, ...(node.children ?? []).map(renderHast));
}

// Highlights the whole block so multi-line tokens (comments, strings) stay coloured on every line.
export function highlightLines(code: string, lang: string | undefined): ReactNode[][] {
  const plain = code.split("\n");
  if (!lang) return plain.map((l) => [l]);
  try {
    const tree = lowlight.highlight(lang, code) as unknown as { children: HNode[] };
    const lines = splitLines(tree.children);
    if (lines.length !== plain.length) return plain.map((l) => [l]);
    return lines.map((l) => l.map(renderHast));
  } catch {
    return plain.map((l) => [l]);
  }
}

export const markdownHighlight = [rehypeHighlight, { languages: common, detect: false }] as [
  typeof rehypeHighlight,
  { languages: typeof common; detect: boolean },
];
