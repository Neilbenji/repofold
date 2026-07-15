import { visit } from "unist-util-visit";

const CALLOUT_RE = /^(note|tip|warning|important|caution)$/i;
const GH_ALERT_RE = /^\[!(note|tip|warning|important|caution)\]\s*/i;

/**
 * Turn `> **Note:** ...` and GitHub `> [!NOTE]` blockquotes into styled callouts.
 */
export function remarkCallouts() {
  return (tree: any) => {
    visit(tree, "blockquote", (node: any) => {
      const first = node.children?.[0];
      if (!first || first.type !== "paragraph") return;
      let type: string | null = null;

      const firstChild = first.children?.[0];
      // **Note:** prefix
      if (firstChild?.type === "strong") {
        const label = (firstChild.children?.[0]?.value ?? "").replace(/:$/, "");
        if (CALLOUT_RE.test(label)) {
          type = label.toLowerCase();
          first.children.shift();
          // strip a leading ":" or whitespace from the following text node
          const next = first.children[0];
          if (next?.type === "text") next.value = next.value.replace(/^:?\s*/, "");
        }
      }
      // [!NOTE] alert syntax
      else if (firstChild?.type === "text" && GH_ALERT_RE.test(firstChild.value)) {
        type = GH_ALERT_RE.exec(firstChild.value)![1].toLowerCase();
        firstChild.value = firstChild.value.replace(GH_ALERT_RE, "");
      }

      if (type) {
        node.data = node.data ?? {};
        node.data.hProperties = { className: ["callout", `callout-${type}`] };
      }
    });
  };
}
