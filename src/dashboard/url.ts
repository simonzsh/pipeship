// Dashboard URL state, pure so tests can import it.
export interface UrlState { p: string | null; repo: string | null }

export function parseUrl(search: string): UrlState {
  const q = new URLSearchParams(search);
  return { p: q.get("p") || null, repo: q.get("repo") || null };
}

// "/" stays readable so a bookmarked repo path stays legible.
export function buildSearch(s: UrlState): string {
  const enc = (v: string) => encodeURIComponent(v).replaceAll("%2F", "/");
  const parts = [s.p && `p=${enc(s.p)}`, s.repo && `repo=${enc(s.repo)}`].filter(Boolean);
  return parts.length ? `?${parts.join("&")}` : "";
}
