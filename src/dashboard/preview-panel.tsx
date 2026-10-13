import { ExternalLink, Globe } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "./components/ui/badge";
import { repoName } from "../repos.ts";
import { Button } from "./components/ui/button";

// Structural type, so this file typechecks with or without the core chunk's PreviewService.
type PanelPreview = { url: string; services?: { name: string; kind: string; url: string; repo?: string }[] };

// Tailwind preflight resets lists and headings, so the guide styles them here.
// react-markdown also passes a `node` prop: drop it so it does not reach the DOM.
const styled =
  (Tag: string, className: string, extra?: object) =>
  ({ node: _node, ...props }: { node?: unknown }) => {
    const El = Tag as React.ElementType;
    return <El {...props} {...extra} className={className} />;
  };

const guideComponents: Components = {
  h1: styled("h3", "mt-3 text-base font-semibold first:mt-0"),
  h2: styled("h4", "mt-3 text-sm font-semibold first:mt-0"),
  h3: styled("h5", "mt-2 text-sm font-medium first:mt-0"),
  p: styled("p", "my-1.5"),
  ul: styled("ul", "my-1.5 list-disc space-y-1 pl-5"),
  ol: styled("ol", "my-1.5 list-decimal space-y-1 pl-5"),
  // The guide comes from an agent: open links in a new tab, never in the dashboard.
  a: styled("a", "text-primary underline underline-offset-2", { target: "_blank", rel: "noopener noreferrer" }),
  code: styled("code", "rounded bg-muted px-1 py-0.5 font-mono text-xs"),
  pre: styled("pre", "my-2 overflow-x-auto rounded bg-muted p-2 text-xs [&_code]:bg-transparent [&_code]:p-0"),
};

export function PreviewPanel({ preview, guide }: { preview: PanelPreview; guide?: string }) {
  const services = preview.services ?? [];
  // Repo names only help when the services come from different repos.
  const multiRepo = new Set(services.map((s) => s.repo)).size > 1;
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
      {guide && (
        <div className="mt-2 border-t border-emerald-500/20 pt-2 text-sm leading-relaxed">
          {/* GFM turns the bare test URLs into links. */}
          <Markdown remarkPlugins={[remarkGfm]} components={guideComponents}>{guide}</Markdown>
        </div>
      )}
    </div>
  );
}
