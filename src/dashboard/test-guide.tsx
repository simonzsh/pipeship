import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownHighlight } from "./highlight";

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

export function TestGuide({ guide }: { guide: string }) {
  return (
    <div className="rounded-lg border px-4 py-3 text-sm leading-relaxed">
      {/* GFM turns the bare test URLs into links. */}
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[markdownHighlight]} components={guideComponents}>
        {guide}
      </Markdown>
    </div>
  );
}
