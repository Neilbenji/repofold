// Adapted from repofold-cloud apps/web/lib/markdown.tsx for static rendering:
// server-only removed, next/link replaced by plain anchors, interactive
// components replaced by their static counterparts, citations always plain.
import type { ReactNode } from "react";
import { MarkdownAsync, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import { remarkCallouts } from "./remark-callouts.js";
import { remarkMermaidBlocks } from "./remark-mermaid.js";
import { getHighlighter } from "./shiki.js";
import { CodeBlock, MermaidDiagram } from "./components.js";

function headingWithAnchor(Tag: "h2" | "h3") {
  return function Heading({ id, children }: { id?: string; children?: ReactNode }) {
    return (
      <Tag id={id}>
        <a href={`#${id}`} className="heading-anchor">
          {children}
        </a>
      </Tag>
    );
  };
}

export async function WikiMarkdown({
  markdown,
  resolveInternalHref,
}: {
  markdown: string;
  /** Maps a wiki slug (e.g. "architecture") to a relative href for this page. */
  resolveInternalHref: (slug: string) => string;
}) {
  const highlighter = await getHighlighter();
  const components: Components = {
    img: () => null,
    a: ({ href, children }) => {
      const external = href?.startsWith("http");
      if (external) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={href!.includes("/blob/") ? "cite-link" : undefined}
          >
            {children}
          </a>
        );
      }
      if (href?.startsWith("#")) return <a href={href}>{children}</a>;
      const target = (href ?? "").replace(/^\/?wiki\//, "").replace(/^\//, "");
      return <a href={resolveInternalHref(target)}>{children}</a>;
    },
    pre: (props) => <CodeBlock {...props} />,
    table: (props) => (
      <div className="table-wrap">
        <table {...props} />
      </div>
    ),
    h2: headingWithAnchor("h2"),
    h3: headingWithAnchor("h3"),
    // custom element emitted by remark-mermaid
    "mermaid-diagram": (props: { code?: string }) => <MermaidDiagram code={props.code ?? ""} />,
  } as Components;

  // MarkdownAsync is an async function component (RSC-style). Outside a
  // server-components runtime we call it directly and await the fully
  // resolved element tree, which renderToStaticMarkup can then serialize.
  return MarkdownAsync({
    remarkPlugins: [remarkGfm, remarkCallouts, remarkMermaidBlocks],
    rehypePlugins: [
      rehypeSlug,
      [
        rehypeShikiFromHighlighter,
        highlighter,
        {
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
          defaultLanguage: "text",
          fallbackLanguage: "text",
        },
      ],
    ],
    components,
    children: markdown,
  });
}
