// Citation token expansion, ported from the cloud showcase page
// (repofold-cloud app/showcase/[owner]/[name]/[[...slug]]/page.tsx).
// [[cite:path:S-E]] becomes a markdown link into the repository host when one
// is known, and inline code otherwise (a purely local repo has nothing to
// link to).

export type CitationTarget =
  | { kind: "github"; owner: string; name: string; sha: string }
  | { kind: "url"; base: string; sha: string }
  | { kind: "none" };

export function renderCitations(markdown: string, target: CitationTarget): string {
  return markdown.replace(
    /\[\[cite:([^\]:]+)(?::(\d+)-(\d+))?\]\]/g,
    (_whole, path: string, start?: string, end?: string) => {
      const clean = path.trim();
      const anchor = start && end ? `#L${start}-L${end}` : "";
      const label = start && end ? `${clean}:${start}-${end}` : clean;
      if (target.kind === "none") return `\`${label}\``;
      const base =
        target.kind === "github"
          ? `https://github.com/${target.owner}/${target.name}`
          : target.base.replace(/\/+$/, "");
      const sha = target.kind === "github" ? target.sha : target.sha;
      return `[\`${label}\`](${base}/blob/${sha}/${clean}${anchor})`;
    },
  );
}
