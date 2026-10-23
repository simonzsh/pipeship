import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { DeleteRun } from "../preview.ts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "/home/me/app" -> "~/app"; macOS paths too.
export const shortRepo = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

// "12" for a GitHub PR URL; undefined for other hosts.
export const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

const NETWORK_ERROR = "Network error: the request did not reach the dashboard";

// The error to show for a failed response; the body may not be JSON (proxy error page).
export async function responseError(res: Response): Promise<string> {
  const data: { error?: string } | null = await res.json().catch(() => null);
  return data?.error ?? `Request failed (${res.status})`;
}

// POSTs a pipeline action and returns the error to show, if any.
export async function postAction(id: string, action: string, body?: unknown): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (res.ok) return undefined;
    return await responseError(res);
  } catch {
    return "Network error: the request did not reach the dashboard";
  }
}

const DELETE_ARCHIVED = "/api/pipelines/delete-archived";

// The last batch delete (running or done), if the dashboard answers.
export async function fetchDeleteRun(): Promise<DeleteRun | undefined> {
  try {
    const res = await fetch(DELETE_ARCHIVED, { cache: "no-store" });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

// Polls a running batch delete until it ends. Returns the error to show, if any, including the pipelines that could not go.
export async function followDeleteRun(first: DeleteRun, onProgress?: (run: DeleteRun) => void, pollMs = 1000): Promise<string | undefined> {
  let run = first;
  onProgress?.(run);
  while (run.running) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const next = await fetchDeleteRun();
    if (!next) return NETWORK_ERROR;
    run = next;
    onProgress?.(run);
  }
  if (!run.failed.length) return undefined;
  return `${run.failed.length} not deleted: ${run.failed.map((f) => `${f.id} (${f.error})`).join("; ")}`;
}

// Starts the delete of every archived pipeline and follows it. A run already going is followed, not an error.
export async function deleteArchived(onProgress?: (run: DeleteRun) => void): Promise<string | undefined> {
  try {
    const res = await fetch(DELETE_ARCHIVED, { method: "POST" });
    if (!res.ok && res.status !== 409) return await responseError(res);
    const run: DeleteRun | undefined = res.ok ? await res.json() : await fetchDeleteRun();
    return run ? await followDeleteRun(run, onProgress) : NETWORK_ERROR;
  } catch {
    return NETWORK_ERROR;
  }
}
