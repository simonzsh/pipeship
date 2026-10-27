import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configPath, readConfig, setDashboard } from "../src/config.ts";
import { readState } from "../src/state.ts";

const root = mkdtempSync(join(tmpdir(), "pipeship-config-"));
const prev = process.env.PIPESHIP_HOME;
const cli = resolve(import.meta.dir, "../src/cli.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.PIPESHIP_HOME;
  else process.env.PIPESHIP_HOME = prev;
  rmSync(root, { recursive: true, force: true });
});

let home = "";
let n = 0;
beforeEach(() => {
  home = join(root, `home-${++n}`);
  process.env.PIPESHIP_HOME = home;
});

const run = (...args: string[]) => spawnSync("bun", [cli, ...args], { encoding: "utf8", env: { ...process.env, PIPESHIP_HOME: home } });
const write = (text: string) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), text);
};

describe("readConfig", () => {
  test("defaults to on with no file", () => {
    expect(readConfig()).toEqual({ dashboard: true });
  });

  test.each(["{not json", "[]", "null", '{"dashboard":"off"}'])("defaults to on for %s", (text) => {
    write(text);
    expect(readConfig()).toEqual({ dashboard: true });
  });
});

describe("setDashboard", () => {
  test("persists, creating the home folder", () => {
    expect(setDashboard(false)).toEqual({ dashboard: false });
    expect(configPath()).toBe(join(home, "config.json"));
    expect(readConfig()).toEqual({ dashboard: false });
    expect(setDashboard(true)).toEqual({ dashboard: true });
    expect(readConfig()).toEqual({ dashboard: true });
  });

  test("keeps unknown keys", () => {
    write('{"other":1}');
    setDashboard(false);
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ other: 1, dashboard: false });
  });
});

describe("pipeship config", () => {
  test("prints the setting and saves it", () => {
    expect(JSON.parse(run("config").stdout)).toEqual({ dashboard: "on", path: join(home, "config.json") });
    expect(JSON.parse(run("config", "dashboard", "off").stdout).dashboard).toBe("off");
    expect(JSON.parse(run("config").stdout).dashboard).toBe("off");
  });

  test("refuses a bad value or key", () => {
    const value = run("config", "dashboard", "maybe");
    expect(value.status).toBe(1);
    expect(value.stderr).toContain("expected on or off");
    const key = run("config", "nope", "on");
    expect(key.status).toBe(1);
    expect(key.stderr).toContain("unknown setting: nope (expected dashboard)");
  });

  test("new records the setting on the pipeline", () => {
    const repo = join(root, `repo-${n}`);
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    run("config", "dashboard", "off");
    const out = JSON.parse(run("new", "--repo", repo, "--title", "t", "--name", "x").stdout);
    expect(out.dashboard).toBe("off");
    expect(readState(out.id).dashboard).toBe(false);
    run("config", "dashboard", "on");
    const on = JSON.parse(run("new", "--repo", repo, "--title", "t", "--name", "y").stdout);
    expect(on.dashboard).toBe("on");
  });
});
