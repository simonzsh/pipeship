import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const skillsRoot = join(import.meta.dir, "../skills");
const folders = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsRoot, d.name, "SKILL.md")))
  .map((d) => d.name);

const IMPLICIT: Record<string, boolean> = { run: true, review: true, dashboard: false, update: true };
const BRIEFS = ["explore", "plan", "implement", "global-review", "cleanup"];
const REFS: Record<string, string[]> = {
  run: BRIEFS.map((name) => `<skill dir>/prompts/${name}.md`),
  review: ["<run dir>/prompts/global-review.md", "<run dir>/prompts/cleanup.md"],
};

// Expands a `<skill dir>/` or `<run dir>/` placeholder to a real path.
const resolveRef = (ref: string, dir: string) =>
  ref.replace("<skill dir>", dir).replace("<run dir>", join(skillsRoot, "run"));

test("the run skill exists and ship is gone", () => {
  expect(folders).toContain("run");
  expect(folders).not.toContain("ship");
});

describe.each(folders)("skill %s", (name) => {
  const dir = join(skillsRoot, name);
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");

  test("frontmatter name equals the folder name", () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1]).toBe(name);
  });

  test("agents/openai.yaml sets the implicit invocation policy", () => {
    const yaml = join(dir, "agents/openai.yaml");
    expect(existsSync(yaml)).toBe(true);
    expect(name in IMPLICIT).toBe(true);
    expect(readFileSync(yaml, "utf8")).toContain(`allow_implicit_invocation: ${IMPLICIT[name]}`);
  });

  test("every <skill dir>/ path exists", () => {
    for (const m of skill.matchAll(/<skill dir>\/[\w./-]+\.md/g)) expect(existsSync(resolveRef(m[0], dir))).toBe(true);
  });

  test("every <run dir>/ path exists under skills/run", () => {
    for (const m of skill.matchAll(/<run dir>\/[\w./-]+\.md/g)) expect(existsSync(resolveRef(m[0], dir))).toBe(true);
  });

  test("the briefs are referenced from SKILL.md", () => {
    for (const ref of REFS[name] ?? []) {
      expect(skill).toContain(ref);
      expect(existsSync(resolveRef(ref, dir))).toBe(true);
    }
  });
});
