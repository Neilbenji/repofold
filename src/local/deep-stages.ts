// Deep-mode stage runners: L1 (deep file summaries) and L2 (fact mining),
// operating on the orchestrator's in-memory context.
import { resolveImport } from "../vendor/pipeline/modules.js";
import type { ModuleGraph } from "../vendor/pipeline/modules.js";
import type { SourceStore } from "../vendor/pipeline/source-store.js";
import type { Symbol } from "../vendor/pipeline/treesitter.js";
import type { UsageSink } from "../vendor/llm/client.js";
import type { AnalysisRecord, Fact, StateStore } from "../state.js";
import type { IngestedFile } from "../ingest.js";
import type { Progress } from "../progress.js";
import type { RepofoldConfig } from "../config.js";
import {
  DEEP_FILE_SUMMARY_VERSION,
  deepContentFits,
  pickDeepSummaryFiles,
  summarizeFileDeep,
} from "./deep-summaries.js";
import {
  FACTS_VERSION,
  carryForwardFacts,
  mineFileFacts,
  mineSymbolFacts,
  selectSymbols,
  sliceSymbolSource,
} from "./facts.js";
import type { EtaTracker } from "./eta.js";

export const DEEP_FILES_PER_MODULE = 12;
export const FACTS_PER_MODULE = 25;

/** Bounded-concurrency pool (the Bottleneck limiter throttles further). */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export const FILE_FACT_CAP = 12;

export type DeepContext = {
  config: RepofoldConfig;
  store: StateStore;
  sourceStore: SourceStore;
  progress: Progress;
  eta: EtaTracker;
  repoHeader: string;
  model: string;
  /** config/infra files that get file-level facts (no symbols) */
  infraFiles: IngestedFile[];
  sourceFiles: IngestedFile[];
  fileByPath: Map<string, IngestedFile>;
  analysisMap: Map<string, AnalysisRecord>;
  oldShaByPath: Map<string, string>;
  transientSkeletons: Map<string, string>;
  importsByPath: Map<string, string[]>;
  workspaceNameToDir: Map<string, string>;
  graph: ModuleGraph;
  rankOf: (path: string) => number;
};

/** Reverse import index: which files resolve an import onto `path`. */
export function buildImporterIndex(ctx: DeepContext): Map<string, string[]> {
  const filePathSet = new Set(ctx.sourceFiles.map((f) => f.path));
  const importers = new Map<string, string[]>();
  for (const from of ctx.sourceFiles) {
    for (const spec of ctx.importsByPath.get(from.path) ?? []) {
      const resolved = resolveImport(from.path, spec, filePathSet, ctx.workspaceNameToDir, from.language);
      if (resolved.file && resolved.file !== from.path) {
        if (!importers.has(resolved.file)) importers.set(resolved.file, []);
        importers.get(resolved.file)!.push(from.path);
      }
    }
  }
  return importers;
}

/** The files that get the one-call-per-file deep treatment (top-K per module). */
export function deepFileSet(ctx: DeepContext): Set<string> {
  const deep = new Set<string>();
  for (const m of ctx.graph.modules) {
    for (const f of pickDeepSummaryFiles(m.filePaths, ctx.fileByPath, ctx.rankOf, DEEP_FILES_PER_MODULE)) {
      deep.add(f.path);
    }
  }
  return deep;
}

/** L1: deep summaries for the selected files; caller batch-summarizes the tail. */
export async function runDeepSummaries(
  ctx: DeepContext,
  targets: IngestedFile[],
  onUsage: UsageSink,
): Promise<void> {
  const need = targets.filter((f) => {
    const a = ctx.analysisMap.get(f.blobSha);
    return (
      a &&
      (a.deepSummary == null ||
        a.deepSummaryVersion !== DEEP_FILE_SUMMARY_VERSION ||
        a.deepSummaryModel !== ctx.model)
    );
  });
  ctx.eta.begin("deep-summary", need.length);
  let done = 0;
  await runPool(need, ctx.config.concurrency, async (f) => {
    const a = ctx.analysisMap.get(f.blobSha)!;
    const content = (await ctx.sourceStore.getMany([f.blobSha])).get(f.blobSha);
    if (content == null) return;
    const full = deepContentFits(content);
    const body = full ? content : (ctx.transientSkeletons.get(f.blobSha) ?? content.slice(0, 24_000));
    const started = Date.now();
    try {
      a.deepSummary = await summarizeFileDeep(
        ctx.repoHeader,
        {
          path: f.path,
          language: f.language,
          content: body,
          isFullSource: full,
          symbols: a.symbols,
          imports: a.imports,
        },
        onUsage,
      );
      a.deepSummaryVersion = DEEP_FILE_SUMMARY_VERSION;
      a.deepSummaryModel = ctx.model;
      await ctx.store.saveAnalysis(f.blobSha, a);
    } catch (err) {
      ctx.progress.warn(
        `deep summary failed for ${f.path}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
    ctx.eta.record("deep-summary", Date.now() - started);
    done++;
    ctx.progress.tick(
      `${done}/${need.length} files ${ctx.eta.remaining("deep-summary", ctx.config.concurrency)}`,
    );
  });
}

export type FactIndex = {
  byId: Map<string, Fact>;
  byPath: Map<string, Fact[]>;
};

/** L2: mine facts per selected symbol, with carry-forward across line drift. */
export async function runFactMining(ctx: DeepContext, onUsage: UsageSink): Promise<FactIndex> {
  const importerIndex = buildImporterIndex(ctx);
  const globalCap = Math.min(1200, 4 * ctx.sourceFiles.length);

  // plan the work: per module (rank order), per file, capped
  type Job = { file: IngestedFile; symbols: Symbol[] };
  const jobs: Job[] = [];
  let globalCount = 0;
  for (const m of ctx.graph.modules) {
    let moduleCount = 0;
    const members = [...m.filePaths]
      .map((p) => ctx.fileByPath.get(p))
      .filter((f): f is IngestedFile => !!f)
      .sort((a, b) => ctx.rankOf(b.path) - ctx.rankOf(a.path) || (a.path < b.path ? -1 : 1));
    for (const f of members) {
      if (moduleCount >= FACTS_PER_MODULE || globalCount >= globalCap) break;
      const a = ctx.analysisMap.get(f.blobSha);
      if (!a || a.symbols.length === 0) continue;
      const take = Math.min(ctx.config.symbolCap, FACTS_PER_MODULE - moduleCount, globalCap - globalCount);
      const selected = selectSymbols(a.symbols, take);
      if (selected.length === 0) continue;
      jobs.push({ file: f, symbols: selected });
      moduleCount += selected.length;
      globalCount += selected.length;
    }
  }

  const index: FactIndex = { byId: new Map(), byPath: new Map() };
  const addFacts = (facts: Fact[]) => {
    for (const fact of facts) {
      index.byId.set(fact.id, fact);
      if (!index.byPath.has(fact.path)) index.byPath.set(fact.path, []);
      index.byPath.get(fact.path)!.push(fact);
    }
  };

  // file-level fact jobs for infra/config files (path-only citations)
  const fileFactJobs: IngestedFile[] = [];
  for (const f of ctx.infraFiles.slice(0, FILE_FACT_CAP)) {
    if (!f.hasContent) continue;
    const existing = await ctx.store.loadFacts(f.blobSha);
    if (existing && existing.version === FACTS_VERSION && existing.model === ctx.model) {
      addFacts(existing.facts);
    } else {
      fileFactJobs.push(f);
    }
  }

  // resolve caches / carry-forward, collect symbols that truly need mining
  type MineJob = { file: IngestedFile; symbol: Symbol; filePurpose: string };
  const toMine: MineJob[] = [];
  for (const job of jobs) {
    const a = ctx.analysisMap.get(job.file.blobSha)!;
    const purpose = a.deepSummary?.purpose ?? a.summary?.purpose ?? "";
    const existing = await ctx.store.loadFacts(job.file.blobSha);
    if (existing && existing.version === FACTS_VERSION && existing.model === ctx.model) {
      addFacts(existing.facts);
      // symbols selected now but never mined before still need a call
      const covered = new Set(existing.facts.map((f) => f.symbol));
      for (const s of job.symbols) {
        if (!covered.has(s.name)) toMine.push({ file: job.file, symbol: s, filePurpose: purpose });
      }
      continue;
    }
    // carry-forward from the previous blob of the same path
    const oldSha = ctx.oldShaByPath.get(job.file.path);
    const oldFacts = oldSha && oldSha !== job.file.blobSha ? await ctx.store.loadFacts(oldSha) : null;
    let kept: Fact[] = [];
    if (oldFacts && oldFacts.version === FACTS_VERSION && oldFacts.model === ctx.model) {
      const oldSymbols = ctx.analysisMap.get(oldSha!)?.symbols ?? [];
      const carried = carryForwardFacts(oldFacts.facts, job.file.path, oldSymbols, a.symbols);
      kept = carried.kept;
    }
    addFacts(kept);
    const covered = new Set(kept.map((f) => f.symbol));
    for (const s of job.symbols) {
      if (!covered.has(s.name)) toMine.push({ file: job.file, symbol: s, filePurpose: purpose });
    }
    if (kept.length > 0) {
      await ctx.store.saveFacts(job.file.blobSha, {
        version: FACTS_VERSION,
        model: ctx.model,
        facts: kept,
      });
    }
  }

  ctx.eta.begin("facts", toMine.length + fileFactJobs.length);
  let done = 0;
  const totalJobs = toMine.length + fileFactJobs.length;
  const mined = new Map<string, Fact[]>(); // blobSha -> new facts

  await runPool(fileFactJobs, ctx.config.concurrency, async (f) => {
    const content = (await ctx.sourceStore.getMany([f.blobSha])).get(f.blobSha);
    if (content == null) return;
    const started = Date.now();
    try {
      const facts = await mineFileFacts(ctx.repoHeader, { path: f.path, content }, onUsage);
      addFacts(facts);
      await ctx.store.saveFacts(f.blobSha, { version: FACTS_VERSION, model: ctx.model, facts });
    } catch (err) {
      ctx.progress.warn(
        `file fact mining failed for ${f.path}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
    ctx.eta.record("facts", Date.now() - started);
    done++;
    ctx.progress.tick(`${done}/${totalJobs} items ${ctx.eta.remaining("facts", ctx.config.concurrency)}`);
  });

  await runPool(toMine, ctx.config.concurrency, async (job) => {
    const content = (await ctx.sourceStore.getMany([job.file.blobSha])).get(job.file.blobSha);
    if (content == null) return;
    const started = Date.now();
    try {
      const facts = await mineSymbolFacts(
        ctx.repoHeader,
        {
          path: job.file.path,
          filePurpose: job.filePurpose,
          symbol: job.symbol,
          sourceSlice: sliceSymbolSource(content, job.symbol),
          importers: importerIndex.get(job.file.path) ?? [],
        },
        onUsage,
      );
      addFacts(facts);
      if (!mined.has(job.file.blobSha)) mined.set(job.file.blobSha, []);
      mined.get(job.file.blobSha)!.push(...facts);
    } catch (err) {
      ctx.progress.warn(
        `fact mining failed for ${job.file.path}#${job.symbol.name}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
    ctx.eta.record("facts", Date.now() - started);
    done++;
    ctx.progress.tick(`${done}/${totalJobs} items ${ctx.eta.remaining("facts", ctx.config.concurrency)}`);
  });

  // persist newly mined facts merged with whatever the blob already had
  for (const [blobSha, facts] of mined) {
    const existing = await ctx.store.loadFacts(blobSha);
    const merged = new Map<string, Fact>();
    if (existing && existing.version === FACTS_VERSION && existing.model === ctx.model) {
      for (const f of existing.facts) merged.set(f.id, f);
    }
    for (const f of facts) merged.set(f.id, f);
    await ctx.store.saveFacts(blobSha, {
      version: FACTS_VERSION,
      model: ctx.model,
      facts: [...merged.values()],
    });
  }

  return index;
}

/** Pre-run call estimate for the ETA banner. */
export function estimateDeepCalls(ctx: DeepContext, targets: IngestedFile[]): { l1: number; l2: number } {
  const l1 = targets.filter((f) => {
    const a = ctx.analysisMap.get(f.blobSha);
    return (
      a &&
      (a.deepSummary == null ||
        a.deepSummaryVersion !== DEEP_FILE_SUMMARY_VERSION ||
        a.deepSummaryModel !== ctx.model)
    );
  }).length;
  const globalCap = Math.min(1200, 4 * ctx.sourceFiles.length);
  const l2 = Math.min(
    globalCap,
    ctx.graph.modules.reduce(
      (sum, m) => sum + Math.min(FACTS_PER_MODULE, m.filePaths.length * ctx.config.symbolCap),
      0,
    ),
  );
  return { l1, l2 };
}
