import { ExternalLink, Globe } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";

// Structural type, so this file typechecks with or without the core chunk's PreviewService.
type PanelPreview = { url: string; services?: { name: string; kind: string; url: string }[] };

export function PreviewPanel({ preview }: { preview: PanelPreview }) {
  const services = preview.services ?? [];
  return (
    <div className="flex flex-col rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Globe className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <a href={preview.url} target="_blank" className="truncate font-mono text-sm hover:underline">
          {preview.url}
        </a>
        <Button asChild size="sm" className="ml-auto">
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
