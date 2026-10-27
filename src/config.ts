import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./state.ts";

export interface Config {
  dashboard: boolean; // false: the run skill does not start or update the dashboard
}

export function configPath(): string {
  return join(home(), "config.json");
}

function readRaw(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readConfig(): Config {
  const { dashboard } = readRaw();
  return { dashboard: typeof dashboard === "boolean" ? dashboard : true };
}

export function setDashboard(on: boolean): Config {
  mkdirSync(home(), { recursive: true });
  const path = configPath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...readRaw(), dashboard: on }, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return readConfig();
}
