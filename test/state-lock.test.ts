import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createPipeline, LOCK_STALE_MS, lockPath, pipelineDir, readState, statePath, updateState, upsertChunk, withStateLock } from "../src/state.ts";

const root = mkdtempSync(join(tmpdir(), "pipeship-lock-"));
const prev = process.env.PIPESHIP_HOME;
const stateTs = resolve(import.meta.dir, "../src/state.ts");

beforeAll(() => {
  process.env.PIPESHIP_HOME = root;
});
afterAll(() => {
  if (prev === undefined) delete process.env.PIPESHIP_HOME;
  else process.env.PIPESHIP_HOME = prev;
  rmSync(root, { recursive: true, force: true });
});

const fresh = () => createPipeline({ repos: [{ path: root }], title: "lock", source: "text" }).id;
const tmpFiles = (id: string) => readdirSync(pipelineDir(id)).filter((f) => f.endsWith(".tmp"));

describe("state lock", () => {
  test("concurrent writers lose no update", async () => {
    const id = fresh();
    const code = `import { upsertChunk } from ${JSON.stringify(stateTs)};
for (let j = 0; j < 25; j++) upsertChunk(${JSON.stringify(id)}, { name: "c" + process.argv[1] + "-" + j });`;
    const codes = await Promise.all(
      [0, 1, 2, 3].map(
        (i) =>
          new Promise<number | null>((done) => {
            const p = spawn("bun", ["-e", code, String(i)], { env: { ...process.env, PIPESHIP_HOME: root }, stdio: "ignore" });
            p.on("close", done);
          }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(readFileSync(statePath(id), "utf8")).chunks).toHaveLength(100);
    expect(tmpFiles(id)).toEqual([]);
    expect(existsSync(lockPath(id))).toBe(false);
  }, 60_000);

  test("a lock held by a dead pid is broken", async () => {
    const id = fresh();
    const p = spawn("true");
    const pid = p.pid!;
    await new Promise((r) => p.on("close", r));
    writeFileSync(lockPath(id), JSON.stringify({ pid, token: "dead" }));
    upsertChunk(id, { name: "a" });
    expect(readState(id).chunks).toHaveLength(1);
    expect(existsSync(lockPath(id))).toBe(false);
  });

  test("a lock older than the stale limit is broken even if its pid is alive", () => {
    const id = fresh();
    const p = spawn("sleep", ["30"]);
    try {
      writeFileSync(lockPath(id), JSON.stringify({ pid: p.pid, token: "old" }));
      const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
      utimesSync(lockPath(id), old, old);
      upsertChunk(id, { name: "a" });
      expect(readState(id).chunks).toHaveLength(1);
    } finally {
      p.kill();
    }
  });

  test("waiting for a live lock is bounded", () => {
    const id = fresh();
    const p = spawn("sleep", ["30"]);
    try {
      writeFileSync(lockPath(id), JSON.stringify({ pid: p.pid, token: "live" }));
      const t = Date.now();
      expect(() => withStateLock(id, () => 1, { waitMs: 200 })).toThrow("is locked by pid");
      const elapsed = Date.now() - t;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      p.kill();
    }
  });

  test("a throw inside change leaves state unchanged and no lock", () => {
    const id = fresh();
    const before = readFileSync(statePath(id), "utf8");
    expect(() =>
      updateState(id, (s) => {
        s.ticket.title = "changed";
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readFileSync(statePath(id), "utf8")).toBe(before);
    expect(existsSync(lockPath(id))).toBe(false);
    expect(tmpFiles(id)).toEqual([]);
  });

  test("a nested updateState on the same id completes", () => {
    const id = fresh();
    withStateLock(id, () => {
      updateState(id, (s) => void (s.ticket.title = "nested"));
    });
    expect(readState(id).ticket.title).toBe("nested");
    expect(existsSync(lockPath(id))).toBe(false);
  });

  test("an unknown pipeline is reported", () => {
    expect(() => withStateLock("nope", () => 1)).toThrow("unknown pipeline: nope");
  });
});
