export interface UpdateInfo { current: string; latest: string | null; available: boolean; harness?: "claude" | "codex" | null }

// The page reloads once the restarted server reports another version than the one it had before.
export const shouldReload = (before: string, after: string | undefined) => !!after && after !== before;

// Reads an error message from a failed response; the body may not be JSON.
export async function responseError(res: Response): Promise<string> {
  const data: { error?: string } | null = await res.json().catch(() => null);
  return data?.error ?? `Request failed (${res.status})`;
}
