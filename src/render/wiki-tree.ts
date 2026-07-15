export type WikiPageRow = {
  id: number;
  slug: string;
  title: string;
  kind: string;
  parentId: number | null;
  position: number;
};

export type WikiNode = {
  slug: string;
  title: string;
  kind: string;
  children: WikiNode[];
};

/** Build the 2-level tree: sections (kind=section) with children; loose pages become top-level nodes. */
export function buildWikiTree(rows: WikiPageRow[]): WikiNode[] {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  const sections = sorted.filter((r) => r.kind === "section");
  const byParent = new Map<number, WikiPageRow[]>();
  const loose: WikiPageRow[] = [];
  for (const row of sorted) {
    if (row.kind === "section") continue;
    if (row.parentId != null) {
      if (!byParent.has(row.parentId)) byParent.set(row.parentId, []);
      byParent.get(row.parentId)!.push(row);
    } else {
      loose.push(row);
    }
  }
  const nodes: WikiNode[] = [];
  for (const row of sorted) {
    if (row.kind === "section") {
      nodes.push({
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        children: (byParent.get(row.id) ?? []).map((c) => ({
          slug: c.slug,
          title: c.title,
          kind: c.kind,
          children: [],
        })),
      });
    } else if (row.parentId == null) {
      nodes.push({ slug: row.slug, title: row.title, kind: row.kind, children: [] });
    }
  }
  return nodes.filter((n) => n.kind !== "section" || n.children.length > 0);
}

/** Depth-first flatten of navigable pages (sections excluded). */
export function flattenPages(tree: WikiNode[]): Array<{ slug: string; title: string; kind: string; sectionTitle: string }> {
  const out: Array<{ slug: string; title: string; kind: string; sectionTitle: string }> = [];
  for (const node of tree) {
    if (node.kind === "section") {
      for (const child of node.children) {
        out.push({ slug: child.slug, title: child.title, kind: child.kind, sectionTitle: node.title });
      }
    } else {
      out.push({ slug: node.slug, title: node.title, kind: node.kind, sectionTitle: "" });
    }
  }
  return out;
}
