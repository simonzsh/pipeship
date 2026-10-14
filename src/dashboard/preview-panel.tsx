import { ExternalLink, Globe } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { repoName } from "../repos.ts";

// Structural type, so this file typechecks with or without the core chunk's PreviewService.
type PanelPreview = { url: string; services?: { name: string; kind: string; url: string; repo?: string }[] };

export function PreviewPanel({ preview }: { preview: PanelPreview }) {
  const services = preview.services ?? [];
  // Repo names only help when the services come from different repos.
  const multiRepo = new Set(services.flatMap((s) => (s.repo ? [s.repo] : []))).size > 1;
  return (
    <div className="flex flex-col rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Globe className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <a href={preview.url} target="_blank" className="truncate font-mono text-sm hover:underline">
          {preview.url}
        </a>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="ml-auto border border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
        >
          <a href={preview.url} target="_blank">
            Open <ExternalLink />
          </a>
        </Button>
      </div>
      {services.length > 1 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-emerald-500/20 pt-2 text-sm">
          {services.map((s) => (
            <li key={s.name} className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <Badge variant="secondary">{s.kind}</Badge>
              {multiRepo && s.repo && <span className="text-xs text-muted-foreground">{repoName(s.repo)}</span>}
              <a href={s.url} target="_blank" className="truncate font-mono text-muted-foreground hover:underline">
                {s.url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Same box as the live preview, in grey: the test guide below it still applies.
export function NoPreviewPanel() {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
      <Globe className="size-4 shrink-0" />
      No preview running
    </div>
  );
}
