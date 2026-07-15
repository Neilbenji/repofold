// Static counterparts of the interactive wiki components from repofold-cloud.
// Interactivity (copy button, mermaid rendering) is restored in the browser by
// the small vanilla scripts shipped in assets/js.
import type { ComponentProps } from "react";

/** Same markup as the cloud CodeBlock; assets/js/repofold.js wires the button. */
export function CodeBlock(props: ComponentProps<"pre">) {
  return (
    <div className="codeblock">
      <button className="copy-btn small" type="button">
        Copy
      </button>
      <pre {...props} />
    </div>
  );
}

/**
 * Mermaid placeholder: the diagram source rides along in a <pre class="mermaid">
 * that assets/js/mermaid-init.js renders client-side (local bundle, no CDN).
 */
export function MermaidDiagram({ code }: { code: string }) {
  return (
    <figure className="mermaid-figure">
      <pre className="mermaid">{code}</pre>
    </figure>
  );
}
