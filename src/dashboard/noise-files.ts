const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const NOISE_DIRS = new Set(["__tests__", "__mocks__", "__snapshots__", "test", "tests", "spec", "node_modules", "vendor", "dist"]);

// Tests, snapshots, lockfiles and vendored output: files a reviewer rarely reads.
// package.json never counts, even under node_modules.
export function isNoiseFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  if (name === "package.json") return false;
  if (parts.some((d) => NOISE_DIRS.has(d))) return true;
  return LOCKFILES.has(name) || /\.(test|spec)\.[^.]+$/.test(name) || name.endsWith(".snap") || /_test\.(go|py)$/.test(name) || /^test_.*\.py$/.test(name);
}
