import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import GithubSlugger from "github-slugger";

export type TocItem = { id: string; text: string; depth: 2 | 3 };

/** Extract h2/h3 headings with the same slugs rehype-slug will generate. */
export function extractHeadings(markdown: string): TocItem[] {
  const tree = unified().use(remarkParse).parse(markdown);
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  visit(tree, "heading", (node: any) => {
    const text = toString(node);
    // keep slug sequence in sync with rehype-slug: slug every heading, keep 2/3
    const id = slugger.slug(text);
    if (node.depth === 2 || node.depth === 3) {
      items.push({ id, text, depth: node.depth });
    }
  });
  return items;
}
