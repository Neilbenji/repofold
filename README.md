# RepoFold

Generate a documentation wiki from a local git repository, fully offline. Every claim in the wiki cites the exact file and lines of code it describes, citations are validated against the source, and incremental runs only regenerate what actually changed.

Your code never leaves your machine: the only network traffic is to your own local [Ollama](https://ollama.com) server. No telemetry, no analytics, no external requests of any kind, neither from the CLI nor from the generated site.

This is the open-source engine behind [repofold.dev](https://repofold.dev), the hosted version that syncs automatically with GitHub, uses stronger frontier models, and adds full-text search, Ask-the-repo with cited answers, and an MCP server for coding agents.

## Quickstart

Requirements: Node.js 20+, git, and [Ollama](https://ollama.com).

```bash
# 1. Pull a model (qwen3:8b is the default; see model guidance below)
ollama pull qwen3:8b

# 2. Serve Ollama with a context window large enough for the prompts.
#    THIS MATTERS: many Ollama installs default to a 4096-token context,
#    which silently truncates prompts and produces poor pages.
OLLAMA_CONTEXT_LENGTH=24576 ollama serve

# 3. Generate the wiki for a repository
npx repofold generate path/to/your/repo --serve
```

The wiki lands in `path/to/your/repo/repofold-wiki/`: a static HTML site (works from `file://`, no server needed) plus a `markdown/` export tree. `--serve` opens it on `http://localhost:4173`.

Run it again after changing code: unchanged pages are skipped outright, pages whose cited code merely moved get their citations re-anchored without any model call, and pages with real changes are patched section by section. A wiki changelog records what changed between runs.

## Commands and flags

```
repofold generate [path]        generate or update the wiki (default command)
  --out <dir>                   output directory (default: <path>/repofold-wiki)
  --model <name>                Ollama model for all passes (default: qwen3:8b)
  --planner-model <name>        stronger model for the architecture analysis
  --ollama-url <url>            Ollama server (default: http://localhost:11434)
  --input-budget <n>            prompt input budget in tokens (default: 16000)
  --concurrency <n>             parallel model requests (default: 2)
  --ignore <glob>               extra ignore pattern, repeatable
  --repo-url <url>              base URL for citation links without a GitHub remote
  --force                       discard cached state, regenerate everything
  --no-verify                   skip the fact-check pass
  --markdown-only / --no-markdown
  --serve [port]                serve the output after generating

repofold serve [path]           preview a previously generated wiki
repofold clean [path]           remove the .repofold state and output directory
```

State lives in `<repo>/.repofold/` (add it and `repofold-wiki/` to your `.gitignore`). It holds the content-addressed analysis cache that makes incremental runs cheap; `--force` wipes it.

## Model guidance

- `qwen3:8b` (default): workable pages on an 8 GB GPU, but expect rough edges.
- `qwen3:14b`, `qwen3:30b-a3b`, or `gpt-oss:20b`: noticeably better structure and prose if your hardware allows it.
- `--planner-model` lets you use a bigger model only for the architecture analysis, which has the highest leverage per token.

Set expectations accordingly: local models are slower and less accurate than the frontier models behind the hosted product. A first full run on a mid-size repository takes tens of minutes to hours on consumer hardware; subsequent runs are fast because of the incremental cache. Citation validation is deterministic and runs regardless of model quality, so wrong line references get stripped rather than published.

## How it works

1. The working tree is read through git (your `.gitignore` is respected) and every file is classified and content-hashed with its git blob SHA.
2. Tree-sitter extracts symbols, imports and skeletons per file; results are cached by content hash, so unchanged files are never re-analyzed.
3. The model summarizes files, then modules derived from the real import graph.
4. A reasoning pass writes an architecture brief; a planning pass lays out the wiki (overview, architecture with a dependency diagram, getting started, module pages).
5. Pages are generated with the relevant source in context and must cite `path:line-line` for every claim. Citations are validated against the actual files: ranges that do not match a real symbol are demoted or removed.
6. On later runs, per-page input hashes decide the cheapest sufficient action: skip, re-anchor citations, patch changed sections, or regenerate.

## License

AGPL-3.0. You can use RepoFold freely, including commercially and inside your company. If you offer it as a service to others, the AGPL requires you to publish your modifications. See [LICENSE](LICENSE).

Parts of the pipeline are shared with the hosted product; see [src/vendor/VENDOR.md](src/vendor/VENDOR.md).
