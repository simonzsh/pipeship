const TEST_DIRS = new Set(["__tests__", "__mocks__", "__snapshots__", "test", "tests", "spec"]);

// Test files only: the "Collapse tests" button must not touch lockfiles or build output.
export function isTestFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  if (parts.some((d) => TEST_DIRS.has(d))) return true;
  return /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith(".snap") || /_test\.(go|py)$/.test(name) || /^test_.*\.py$/.test(name);
}
