// Acceptance harness: measures wiki quality from the .repofold state.
// Usage: tsx scripts/eval-wiki.mts <repo-path>
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoPath = process.argv[2];
if (!repoPath) {
  console.error("Usage: tsx scripts/eval-wiki.mts <repo-path>");
  process.exit(1);
}
const stateDir = path.join(repoPath, ".repofold");

type PageRecord = {
  slug: string;
  title: string;
  kind: string;
  status: string;
  warnings: unknown[];
};

const pages = JSON.parse(await readFile(path.join(stateDir, "pages.json"), "utf8")) as PageRecord[];
const detail = pages.filter((p) => p.kind !== "section" && p.status === "published");

const SYNTHESIS = new Set(["overview", "architecture", "coverage"]);
const rows: Array<{
  slug: string;
  kind: string;
  words: number;
  cites: number;
  per250: number;
  h2: number;
  warnings: number;
}> = [];

for (const page of detail) {
  let markdown = "";
  try {
    markdown = await readFile(path.join(stateDir, "pages", `${page.slug}.md`), "utf8");
  } catch {
    continue;
  }
  const words = markdown.split(/\s+/).filter(Boolean).length;
  const cites = (markdown.match(/\[\[cite:/g) ?? []).length;
  rows.push({
    slug: page.slug,
    kind: page.kind,
    words,
    cites,
    per250: words > 0 ? Number(((cites / words) * 250).toFixed(2)) : 0,
    h2: (markdown.match(/^## /gm) ?? []).length,
    warnings: page.warnings?.length ?? 0,
  });
}

rows.sort((a, b) => a.slug.localeCompare(b.slug));
const pad = (v: string | number, n: number) => String(v).padEnd(n);
console.log(pad("page", 32) + pad("kind", 18) + pad("words", 7) + pad("cites", 7) + pad("/250w", 7) + pad("H2", 4) + "warn");
for (const r of rows) {
  console.log(pad(r.slug, 32) + pad(r.kind, 18) + pad(r.words, 7) + pad(r.cites, 7) + pad(r.per250, 7) + pad(r.h2, 4) + r.warnings);
}

const detailRows = rows.filter((r) => !SYNTHESIS.has(r.kind));
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const zero = detailRows.filter((r) => r.cites === 0).length;
console.log("");
console.log(`detail pages: ${detailRows.length}`);
console.log(`zero-citation detail pages: ${zero} (${detailRows.length ? Math.round((zero / detailRows.length) * 100) : 0}%)`);
console.log(`median citations per detail page: ${median(detailRows.map((r) => r.cites))}`);
console.log(`median citations per 250 words: ${median(detailRows.map((r) => r.per250))}`);
console.log(`median words per detail page: ${median(detailRows.map((r) => r.words))}`);
console.log(`median H2 sections: ${median(detailRows.map((r) => r.h2))}`);
console.log(`mean warnings per page: ${(rows.reduce((s, r) => s + r.warnings, 0) / Math.max(1, rows.length)).toFixed(2)}`);
