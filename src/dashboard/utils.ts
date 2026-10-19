import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "/home/me/app" -> "~/app"; macOS paths too.
export const shortRepo = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

// "12" for a GitHub PR URL; undefined for other hosts.
export const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

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

// Deletes every archived pipeline. Returns the error to show, if any, including the ones that could not go.
export async function deleteArchived(): Promise<string | undefined> {
  try {
    const res = await fetch("/api/pipelines/delete-archived", { method: "POST" });
    if (!res.ok) return await responseError(res);
    const { failed }: { failed: { id: string; error: string }[] } = await res.json();
    if (!failed.length) return undefined;
    return `${failed.length} not deleted: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}`;
  } catch {
    return "Network error: the request did not reach the dashboard";
  }
}
