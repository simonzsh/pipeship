import { ExternalLink, Globe } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";

// Structural type, so this file typechecks with or without the core chunk's PreviewService.
type PanelPreview = { url: string; services?: { name: string; kind: string; url: string }[] };

// Tailwind preflight resets lists and headings, so the guide styles them here.
const guideComponents: Components = {
  h1: (p) => <h3 className="mt-3 text-base font-semibold first:mt-0" {...p} />,
  h2: (p) => <h4 className="mt-3 text-sm font-semibold first:mt-0" {...p} />,
  h3: (p) => <h5 className="mt-2 text-sm font-medium first:mt-0" {...p} />,
  p: (p) => <p className="my-1.5" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-1 pl-5" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-1 pl-5" {...p} />,
  a: (p) => <a target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" {...p} />,
  code: (p) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...p} />,
  pre: (p) => <pre className="my-2 overflow-x-auto rounded bg-muted p-2 text-xs [&_code]:bg-transparent [&_code]:p-0" {...p} />,
};

export function PreviewPanel({ preview, guide }: { preview: PanelPreview; guide?: string }) {
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
      {guide && (
        <div className="mt-2 border-t border-emerald-500/20 pt-2 text-sm leading-relaxed">
          <Markdown components={guideComponents}>{guide}</Markdown>
        </div>
      )}
    </div>
  );
}
