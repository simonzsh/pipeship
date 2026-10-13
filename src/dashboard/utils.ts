import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "12" for a GitHub PR URL; undefined for other hosts.
export const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

// POSTs a pipeline action and returns the error to show, if any.
export async function postAction(id: string, action: string, body?: unknown): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (res.ok) return undefined;
    // The body may not be JSON (proxy error page).
    const data: { error?: string } | null = await res.json().catch(() => null);
    return data?.error ?? `Request failed (${res.status})`;
  } catch {
    return "Network error: the request did not reach the dashboard";
  }
}
