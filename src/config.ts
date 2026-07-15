import path from "node:path";

export type RepofoldConfig = {
  /** Absolute path to the target git repository. */
  repoPath: string;
  /** Absolute path to the output directory. */
  outDir: string;
  /**
   * deep: many small focused calls, harness-attached citations (best quality).
   * fast: the cloud-style single-pass pipeline (fewer, larger calls).
   */
  mode: "deep" | "fast";
  /** L2 fact mining: max symbols analyzed per file. */
  symbolCap: number;
  /** Ollama model used for all passes. */
  model: string;
  /** Ollama model used for the architecture brief (planning); defaults to `model`. */
  plannerModel: string;
  /** Base URL of the Ollama server (no trailing slash, no /v1). */
  ollamaUrl: string;
  /** Prompt input budget in tokens. */
  inputBudget: number;
  /** Max parallel LLM requests. */
  concurrency: number;
  /** Extra ignore globs on top of .gitignore and the built-in filter. */
  ignoreGlobs: string[];
  /** Delete all cached state and regenerate from scratch. */
  force: boolean;
  /** Skip the verification pass entirely. */
  verify: boolean;
  /** Emit the markdown export tree. */
  markdown: boolean;
  /** Emit the static HTML site. */
  html: boolean;
  /** Base URL used for citation links when the repo has no GitHub remote. */
  repoUrl?: string;
};

export const DEFAULT_MODEL = "qwen3:8b";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_INPUT_BUDGET = 16_000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_SERVE_PORT = 4173;
export const DEFAULT_SYMBOL_CAP = 8;

export function resolveConfig(targetPath: string, opts: Record<string, unknown>): RepofoldConfig {
  const repoPath = path.resolve(targetPath ?? ".");
  const model = String(opts.model ?? DEFAULT_MODEL);
  return {
    repoPath,
    outDir: path.resolve(String(opts.out ?? path.join(repoPath, "repofold-wiki"))),
    mode: opts.fast === true ? "fast" : "deep",
    symbolCap: Number(opts.symbolCap ?? DEFAULT_SYMBOL_CAP),
    model,
    plannerModel: String(opts.plannerModel ?? model),
    ollamaUrl: String(opts.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, ""),
    inputBudget: Number(opts.inputBudget ?? DEFAULT_INPUT_BUDGET),
    concurrency: Number(opts.concurrency ?? DEFAULT_CONCURRENCY),
    ignoreGlobs: Array.isArray(opts.ignore) ? opts.ignore.map(String) : [],
    force: Boolean(opts.force),
    verify: opts.verify !== false,
    markdown: opts.markdownOnly === true ? true : opts.markdown !== false,
    html: opts.markdownOnly !== true,
    repoUrl: opts.repoUrl ? String(opts.repoUrl) : undefined,
  };
}

export function stateDir(config: Pick<RepofoldConfig, "repoPath">): string {
  return path.join(config.repoPath, ".repofold");
}
