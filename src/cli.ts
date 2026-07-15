#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_CONCURRENCY, DEFAULT_INPUT_BUDGET, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, DEFAULT_SERVE_PORT, resolveConfig } from "./config.js";

const program = new Command();

program
  .name("repofold")
  .description(
    "Generate a documentation wiki from a local git repository, fully offline.\n" +
      "Every claim cites the exact lines of code. Powered by your own Ollama models:\n" +
      "your code never leaves your machine.",
  )
  .version("0.1.0");

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("generate", { isDefault: true })
  .argument("[path]", "path to the git repository", ".")
  .description("generate or update the wiki for a repository")
  .option("--out <dir>", "output directory (default: <path>/repofold-wiki)")
  .option("--model <name>", "Ollama model for all passes", DEFAULT_MODEL)
  .option("--planner-model <name>", "Ollama model for the architecture brief (default: --model)")
  .option("--ollama-url <url>", "Ollama server URL", DEFAULT_OLLAMA_URL)
  .option("--input-budget <n>", "prompt input budget in tokens", String(DEFAULT_INPUT_BUDGET))
  .option("--concurrency <n>", "max parallel LLM requests", String(DEFAULT_CONCURRENCY))
  .option("--ignore <glob>", "extra ignore glob (repeatable)", collect, [] as string[])
  .option("--repo-url <url>", "base URL for citation links when there is no GitHub remote")
  .option("--force", "discard cached state and regenerate everything")
  .option("--no-verify", "skip the verification pass")
  .option("--markdown-only", "emit only the markdown export, no HTML site")
  .option("--no-markdown", "emit only the HTML site, no markdown export")
  .option("--serve [port]", "serve the output after generation")
  .action(async (target: string, opts: Record<string, unknown>) => {
    const config = resolveConfig(target, opts);
    const { runGenerate } = await import("./commands/generate.js");
    const servePort = opts.serve === true ? DEFAULT_SERVE_PORT : opts.serve ? Number(opts.serve) : undefined;
    await runGenerate(config, { servePort });
  });

program
  .command("serve")
  .argument("[path]", "path to the git repository", ".")
  .description("preview a previously generated wiki")
  .option("--out <dir>", "output directory (default: <path>/repofold-wiki)")
  .option("--port <n>", "port to listen on", String(DEFAULT_SERVE_PORT))
  .action(async (target: string, opts: Record<string, unknown>) => {
    const config = resolveConfig(target, opts);
    const { startServer } = await import("./serve.js");
    await startServer(config.outDir, Number(opts.port ?? DEFAULT_SERVE_PORT));
  });

program
  .command("clean")
  .argument("[path]", "path to the git repository", ".")
  .description("remove the .repofold state directory and the default output directory")
  .option("--out <dir>", "output directory to remove (default: <path>/repofold-wiki)")
  .option("--yes", "skip the confirmation prompt")
  .action(async (target: string, opts: Record<string, unknown>) => {
    const config = resolveConfig(target, opts);
    const { runClean } = await import("./commands/clean.js");
    await runClean(config, { yes: Boolean(opts.yes) });
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
