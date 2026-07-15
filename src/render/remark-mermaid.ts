import { visit } from "unist-util-visit";

/** Rewrite ```mermaid code fences into a custom element rendered by MermaidDiagram. */
export function remarkMermaidBlocks() {
  return (tree: any) => {
    visit(tree, "code", (node: any) => {
      if (node.lang === "mermaid") {
        // unknown node type -> remark-rehype builds the element from data.hName
        node.type = "mermaidBlock";
        node.data = {
          hName: "mermaid-diagram",
          hProperties: { code: node.value },
          hChildren: [],
        };
      }
    });
  };
}
