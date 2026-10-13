import { FileText } from "lucide-react";
import { siGithub, siGitlab, siJira, siLinear, siNotion, type SimpleIcon } from "simple-icons";
import type { State } from "../state.ts";

// Icons ship with the page, matched on the source name or the URL's host. Other sources get a plain icon,
// a plain-text ticket (no source, or the legacy "text") gets none.
const KNOWN: { icon: SimpleIcon; source: string; host: string }[] = [
  { icon: siLinear, source: "linear", host: "linear.app" },
  { icon: siNotion, source: "notion", host: "notion.so" },
  { icon: siGithub, source: "github", host: "github.com" },
  { icon: siGitlab, source: "gitlab", host: "gitlab.com" },
  { icon: siJira, source: "jira", host: "atlassian.net" },
];

const SIZE = "size-3.5 shrink-0";

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

export function TicketIcon({ ticket }: { ticket: State["ticket"] }) {
  const source = ticket.source?.toLowerCase();
  const host = hostOf(ticket.links.find((l) => l.url)?.url);
  const known = KNOWN.find((k) => k.source === source || host === k.host || host?.endsWith(`.${k.host}`));

  if (known) {
    return (
      <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={`${SIZE} text-foreground`}>
        <title>{known.icon.title}</title>
        <path d={known.icon.path} />
      </svg>
    );
  }
  if (!source || source === "text") return null;
  return (
    <span title={ticket.source} className="flex">
      <FileText className={`${SIZE} text-muted-foreground`} aria-label={ticket.source} />
    </span>
  );
}
