# Vendored modules

The files in this directory (and part of `src/render/`) are shared with
RepoFold Cloud, the hosted product behind https://repofold.dev. They are
copied, not depended on, so this CLI stays fully standalone.

- Upstream: the private `repofold-cloud` repository
- Synced at upstream commit: `f0f7b2be16d1f54a06e98eb9aaecc116697ae4d8` (2026-07-14)
- Sync tool: `scripts/vendor-sync.mjs` (maintainers only; requires a checkout
  of the upstream repo). The only transform applied is rewriting extensionless
  relative imports to explicit `.js` extensions, because this package compiles
  with NodeNext ESM while the upstream uses bundler resolution.

## File status

| File | Status |
|---|---|
| `pipeline/filter.ts` | synced, unmodified |
| `pipeline/language.ts` | synced, unmodified |
| `pipeline/manifests.ts` | synced, unmodified |
| `pipeline/modules.ts` | synced, unmodified |
| `pipeline/treesitter.ts` | synced, unmodified |
| `pipeline/secret-scanner.ts` | synced, unmodified |
| `pipeline/citation-drift.ts` | synced, unmodified |
| `pipeline/source-store.ts` | synced, unmodified |
| `llm/passes.ts` | synced, unmodified |
| `llm/passes-v2.ts` | synced, unmodified |
| `llm/client.ts` | REWRITTEN for Ollama (same export surface; not synced) |
| `../render/remark-callouts.ts` | synced, unmodified |
| `../render/remark-mermaid.ts` | synced, unmodified |
| `../render/extract-headings.ts` | synced, unmodified |
| `../render/wiki-tree.ts` | synced, unmodified |
| `../render/shiki.ts` | adapted (server-only import removed; not synced) |
| `../render/markdown.tsx` | adapted for static rendering (not synced) |
