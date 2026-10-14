import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const skillDir = join(import.meta.dir, "../skills/ship");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const BRIEFS = ["explore", "plan", "implement", "global-review", "cleanup"];

test("every <skill dir>/ path in SKILL.md exists", () => {
  const paths = [...skill.matchAll(/<skill dir>\/([\w./-]+\.md)/g)].map((m) => m[1]);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect(existsSync(join(skillDir, path))).toBe(true);
});

test("each subagent brief is referenced from SKILL.md", () => {
  for (const name of BRIEFS) {
    expect(existsSync(join(skillDir, "prompts", `${name}.md`))).toBe(true);
    expect(skill).toContain(`<skill dir>/prompts/${name}.md`);
  }
});
