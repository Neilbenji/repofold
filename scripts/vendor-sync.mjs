// Maintainer script: copies the shared pipeline modules from the repofold-cloud
// checkout into src/vendor and src/render, rewriting extensionless relative
// imports to explicit .js extensions (this package compiles with NodeNext ESM;
// the cloud repo uses bundler resolution). Run from the repo root:
//   node scripts/vendor-sync.mjs [path-to-repofold-cloud]
// After syncing, update the commit sha in src/vendor/VENDOR.md.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const cloudRoot = process.argv[2] ?? "../repo-wiki";

const COPIES = [
  ["packages/core/src/pipeline/filter.ts", "src/vendor/pipeline/filter.ts"],
  ["packages/core/src/pipeline/language.ts", "src/vendor/pipeline/language.ts"],
  ["packages/core/src/pipeline/manifests.ts", "src/vendor/pipeline/manifests.ts"],
  ["packages/core/src/pipeline/modules.ts", "src/vendor/pipeline/modules.ts"],
  ["packages/core/src/pipeline/treesitter.ts", "src/vendor/pipeline/treesitter.ts"],
  ["packages/core/src/pipeline/secret-scanner.ts", "src/vendor/pipeline/secret-scanner.ts"],
  ["packages/core/src/pipeline/citation-drift.ts", "src/vendor/pipeline/citation-drift.ts"],
  ["packages/core/src/pipeline/source-store.ts", "src/vendor/pipeline/source-store.ts"],
  ["packages/core/src/llm/passes.ts", "src/vendor/llm/passes.ts"],
  ["packages/core/src/llm/passes-v2.ts", "src/vendor/llm/passes-v2.ts"],
  ["apps/web/lib/remark-callouts.ts", "src/render/remark-callouts.ts"],
  ["apps/web/lib/remark-mermaid.ts", "src/render/remark-mermaid.ts"],
  ["apps/web/lib/extract-headings.ts", "src/render/extract-headings.ts"],
  ["apps/web/lib/wiki-tree.ts", "src/render/wiki-tree.ts"],
];

// NOTE: src/vendor/llm/client.ts, src/render/shiki.ts and src/render/markdown.tsx
// are maintained by hand in this repo (rewritten for Ollama / static rendering)
// and are intentionally NOT synced.

function rewriteImports(source) {
  return source.replace(
    /(from\s+")(\.{1,2}\/[^"]+)(")/g,
    (whole, pre, spec, post) => (path.extname(spec) ? whole : `${pre}${spec}.js${post}`),
  );
}

for (const [from, to] of COPIES) {
  const raw = await readFile(path.resolve(cloudRoot, from), "utf8");
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, rewriteImports(raw), "utf8");
  console.log(`synced ${from} -> ${to}`);
}
console.log("Done. Update the commit sha in src/vendor/VENDOR.md.");
