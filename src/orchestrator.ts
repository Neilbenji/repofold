// The pipeline stage machine: a filesystem-backed port of the cloud worker
// (repofold-cloud apps/worker/src/pipeline.ts). The stages, hash gates and
// cost ladder are preserved verbatim; Postgres/Redis/GitHub are replaced by
// StateStore, local git and the working-tree ingest.
import path from "node:path";
import { EncryptedTempSourceStore } from "./vendor/pipeline/source-store.js";
import { extractStructure, type Symbol } from "./vendor/pipeline/treesitter.js";
import { SKELETON_ONLY_BYTES } from "./vendor/pipeline/filter.js";
import { buildManifestFacts } from "./vendor/pipeline/manifests.js";
import {
  deriveModules,
  moduleGraphToMermaid,
  validatePrunedMermaid,
  type ModuleFacts,
  type ModuleGraph,
} from "./vendor/pipeline/modules.js";
import { remapCitationDrift } from "./vendor/pipeline/citation-drift.js";
import {
  buildRepoHeader,
  inputHash,
  packBatches,
  summarizeBatch,
  validateAndCleanCitations,
  FILE_SUMMARY_PROMPT_VERSION,
  type FileForSummary,
  type FileSummary,
} from "./vendor/llm/passes.js";
import {
  architectureBrief,
  generatePageV2,
  generatePageUpdateV2,
  verifyPageV2,
  moduleInputHash,
  packModuleBatches,
  pageInputHash,
  planWiki,
  stablePageInputHash,
  stripEmDashes,
  normalizePageText,
  summarizeModuleBatch,
  validatePlan,
  MODULE_SUMMARY_PROMPT_VERSION,
  PROMPT_VERSION,
  type EdgeLine,
  type ModuleForSummary,
  type ModuleSummary,
  type PageGenInput,
  type PagePlan,
} from "./vendor/llm/passes-v2.js";
import { chatText, configureLlm, setInputBudgetTokens } from "./vendor/llm/client.js";
import { ingestWorkingTree, type IngestedFile } from "./ingest.js";
import { headSha, isDirty } from "./git.js";
import {
  StateStore,
  treeFingerprint,
  emptyState,
  type AnalysisRecord,
  type FileRecord,
  type ModuleRecord,
  type PageRecord,
  type RepoState,
} from "./state.js";
import { stateDir, type RepofoldConfig } from "./config.js";
import { Progress } from "./progress.js";

const INFRA_PATH_RE =
  /(^|\/)((docker-)?compose(\.[\w.-]+)?\.ya?ml|dockerfile[^/]*|\.env\.(example|sample|template))$|^scripts\/[^/]+\.(sh|ps1|bash)$|^\.github\/workflows\/[^/]+\.ya?ml$/i;

const FULL_SOURCE_MAX_CHARS = 24_000;
const TOTAL_STAGES = 8;

/** Simple promise pool: run tasks with bounded concurrency, preserving errors. */
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

export type PipelineResult = {
  changed: boolean;
  commitSha: string;
  counts: { generated: number; patched: number; remapped: number; skipped: number };
};

export async function runPipeline(
  config: RepofoldConfig,
  repoLabel: { owner: string; name: string },
  progress: Progress,
): Promise<PipelineResult> {
  const store = new StateStore(stateDir(config));
  if (config.force) await store.wipe();

  configureLlm({
    baseUrl: config.ollamaUrl,
    flash: config.model,
    pro: config.plannerModel,
    maxConcurrent: config.concurrency,
  });
  setInputBudgetTokens(config.inputBudget);

  // Model identity for the hash gates: switching --model must invalidate the
  // cheap update tiers, so the ACTUAL Ollama model name is stored, not the
  // role alias baked into the vendored passes.
  const pageModel = config.model;
  const summaryModel = config.model;

  const previousState = await store.load();
  // Changing the input budget changes prompt shape; ignore-glob changes change
  // the file set. Both are handled naturally by the hash gates downstream.
  const state: RepoState = { ...emptyState(), ...previousState };
  state.ignoreGlobs = [...new Set([...state.ignoreGlobs, ...config.ignoreGlobs])];
  state.model = config.model;
  state.plannerModel = config.plannerModel;
  state.inputBudget = config.inputBudget;

  const commitSha = await headSha(config.repoPath);
  if (await isDirty(config.repoPath)) {
    progress.warn(
      `working tree has uncommitted changes; the wiki reflects the working tree but is labeled with commit ${commitSha.slice(0, 7)}`,
    );
  }

  const sourceStore = await EncryptedTempSourceStore.create();
  const counts = { generated: 0, patched: 0, remapped: 0, skipped: 0 };

  try {
    // ---- Stage 1: ingest ----------------------------------------------------
    progress.stage(1, TOTAL_STAGES, "Reading the working tree");
    const previousFiles = await store.loadFiles();
    const oldShaByPath = new Map(previousFiles.map((f) => [f.path, f.blobSha]));

    const outDirRelative = path.relative(config.repoPath, config.outDir);
    const ingest = await ingestWorkingTree({
      repoPath: config.repoPath,
      sourceStore,
      extraIgnoreGlobs: state.ignoreGlobs,
      excludeDirs: [outDirRelative, "repofold-wiki"],
      onProgress: (seen) => progress.tick(`${seen} files scanned`),
    });
    const fileRecords: FileRecord[] = ingest.files.map((f) => ({
      path: f.path,
      language: f.language,
      kind: f.kind,
      blobSha: f.blobSha,
      sizeBytes: f.sizeBytes,
      lineCount: f.lineCount,
    }));
    await store.saveFiles(fileRecords);
    progress.line(
      `${ingest.stats.total} files, ${ingest.stats.analyzable} analyzable (${ingest.stats.skipped} skipped)`,
    );

    // New-code gate: no commit movement AND no working-tree drift -> nothing
    // to generate. (Ingest is local and cheap, so the gate runs after it.)
    const fingerprint = treeFingerprint(
      fileRecords.filter((f) => f.blobSha !== "").map((f) => ({ path: f.path, blobSha: f.blobSha })),
    );
    const pagesNow = await store.loadPages();
    if (
      !config.force &&
      state.lastIndexedCommitSha === commitSha &&
      state.treeFingerprint === fingerprint &&
      pagesNow.some((p) => p.kind !== "section" && p.status === "published")
    ) {
      progress.line("no changes since the last run");
      return { changed: false, commitSha, counts };
    }

    // ---- Stage 2: structure extraction (content-addressed cache) -------------
    const analyzable = ingest.files.filter((f) =>
      ["source", "config", "doc", "data"].includes(f.kind),
    );
    analyzable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const sourceFiles = analyzable.filter((f) => f.kind === "source");
    const transientSkeletons = new Map<string, string>();

    // analysis cache: previous blobs stay on disk until pruned at cutover, so
    // previousSummary and drift lookups for replaced files still resolve
    const analysisMap = new Map<string, AnalysisRecord>();
    const loadAnalysis = async (blobSha: string): Promise<AnalysisRecord | null> => {
      if (analysisMap.has(blobSha)) return analysisMap.get(blobSha)!;
      const record = await store.loadAnalysis(blobSha);
      if (record) analysisMap.set(blobSha, record);
      return record;
    };

    const needExtraction: IngestedFile[] = [];
    for (const f of analyzable) {
      if (!(f.kind === "source" || f.kind === "config" || f.kind === "doc")) continue;
      if (!f.hasContent) continue;
      if ((await loadAnalysis(f.blobSha)) == null) needExtraction.push(f);
    }
    progress.stage(2, TOTAL_STAGES, `Extracting structure (${needExtraction.length} new files)`);
    const EXTRACT_BATCH = 50;
    for (let i = 0; i < needExtraction.length; i += EXTRACT_BATCH) {
      const slice = needExtraction.slice(i, i + EXTRACT_BATCH);
      const contents = await sourceStore.getMany(slice.map((f) => f.blobSha));
      for (const f of slice) {
        const content = contents.get(f.blobSha);
        if (content == null) continue;
        const extraction =
          f.kind === "source"
            ? await extractStructure(f.language ?? "other", content)
            : { symbols: [], imports: [], skeleton: null };
        if (extraction.skeleton) transientSkeletons.set(f.blobSha, extraction.skeleton);
        const record: AnalysisRecord = {
          symbols: extraction.symbols,
          imports: extraction.imports,
          summary: null,
          summaryVersion: null,
          summaryModel: null,
        };
        analysisMap.set(f.blobSha, record);
        await store.saveAnalysis(f.blobSha, record);
      }
      progress.tick(`${Math.min(i + EXTRACT_BATCH, needExtraction.length)}/${needExtraction.length} files`);
    }
    // make sure analysis for all live + previous blobs is in memory
    for (const f of analyzable) await loadAnalysis(f.blobSha);
    for (const sha of oldShaByPath.values()) await loadAnalysis(sha);

    const summaryOf = (blobSha: string): FileSummary | null =>
      analysisMap.get(blobSha)?.summary ?? null;
    const symbolsOf = (blobSha: string): Symbol[] => analysisMap.get(blobSha)?.symbols ?? [];

    // ---- Repo header (stable prompt prefix) ----------------------------------
    const langStats: Record<string, number> = {};
    for (const f of sourceFiles) {
      const l = f.language ?? "other";
      langStats[l] = (langStats[l] ?? 0) + 1;
    }
    const repoHeader = buildRepoHeader({
      owner: repoLabel.owner,
      name: repoLabel.name,
      defaultBranch: "HEAD",
      commitSha,
      languageStats: langStats,
      topLevelDirs: [...new Set(sourceFiles.map((f) => f.path.split("/")[0]))].slice(0, 25),
    });

    // ---- Stage 3: Pass A file summaries ---------------------------------------
    const needSummary = sourceFiles.filter((f) => {
      const a = analysisMap.get(f.blobSha);
      return (
        a &&
        (a.summary == null ||
          a.summaryVersion !== FILE_SUMMARY_PROMPT_VERSION ||
          a.summaryModel !== summaryModel)
      );
    });
    progress.stage(3, TOTAL_STAGES, `Summarizing files (${needSummary.length} of ${sourceFiles.length})`);
    if (needSummary.length > 0) {
      const contents = await sourceStore.getMany(needSummary.map((f) => f.blobSha));
      const forSummary: FileForSummary[] = [];
      for (const f of needSummary) {
        const a = analysisMap.get(f.blobSha)!;
        const content = contents.get(f.blobSha);
        if (content == null) continue;
        const useFullSource = (f.lineCount ?? 0) <= 250 && f.sizeBytes <= SKELETON_ONLY_BYTES;
        const oldSha = oldShaByPath.get(f.path);
        const previousSummary =
          oldSha && oldSha !== f.blobSha
            ? (analysisMap.get(oldSha)?.summary ?? undefined)
            : undefined;
        forSummary.push({
          path: f.path,
          language: f.language,
          imports: a.imports ?? [],
          symbols: a.symbols ?? [],
          body: useFullSource
            ? content
            : (transientSkeletons.get(f.blobSha) ?? content.slice(0, 8000)),
          isFullSource: useFullSource,
          previousSummary,
        });
      }
      const shaByPath = new Map(needSummary.map((f) => [f.path, f.blobSha]));
      const batches = packBatches(forSummary);
      let done = 0;
      for (const [index, batch] of batches.entries()) {
        progress.tick(`batch ${index + 1}/${batches.length} (${done}/${needSummary.length} files)`);
        let summaries: Map<string, FileSummary>;
        try {
          summaries = await summarizeBatch(repoHeader, batch, progress.usageSink);
        } catch (err) {
          progress.warn(
            `file summary batch failed (${batch.length} files, first: ${batch[0]?.path}): ${
              err instanceof Error ? err.message.slice(0, 300) : err
            }`,
          );
          summaries = new Map(
            batch.map((f) => [
              f.path,
              {
                purpose: `File at ${f.path} (${f.language ?? "unknown"}). Automatic summary failed; symbols: ${f.symbols
                  .slice(0, 5)
                  .map((s) => s.name)
                  .join(", ") || "none detected"}.`,
                category: "unknown",
              } satisfies FileSummary,
            ]),
          );
        }
        for (const [filePath, summary] of summaries) {
          const sha = shaByPath.get(filePath);
          if (!sha) continue;
          const record = analysisMap.get(sha);
          if (!record) continue;
          record.summary = summary;
          record.summaryVersion = FILE_SUMMARY_PROMPT_VERSION;
          record.summaryModel = summaryModel;
          await store.saveAnalysis(sha, record);
        }
        done += batch.length;
      }
    }

    // ---- Stage 4: modules (deterministic) -------------------------------------
    progress.stage(4, TOTAL_STAGES, "Deriving modules");
    const manifestCandidates = analyzable.filter(
      (f) =>
        f.kind === "config" ||
        /^\.github\/workflows\//.test(f.path) ||
        /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(f.path) ||
        /(^|\/)\.env\.(example|sample|template)$/i.test(f.path),
    );
    const manifestContents = await sourceStore.getMany(manifestCandidates.map((f) => f.blobSha));
    const manifestFactsResult = buildManifestFacts(
      manifestCandidates
        .map((f) => ({ path: f.path, content: manifestContents.get(f.blobSha) ?? "" }))
        .filter((m) => m.content !== ""),
    );
    const manifestFacts = manifestFactsResult.text;

    const importsByPath = new Map<string, string[]>();
    for (const f of sourceFiles) {
      const a = analysisMap.get(f.blobSha);
      if (a) importsByPath.set(f.path, a.imports ?? []);
    }
    const graph: ModuleGraph = deriveModules({
      files: sourceFiles.map((f) => ({ path: f.path, language: f.language })),
      importsByPath,
      workspaceNameToDir: manifestFactsResult.workspaceNameToDir,
      anchorDirs: manifestFactsResult.anchorDirs,
    });
    progress.line(`${graph.modules.length} modules, ${graph.edges.length} edges`);

    const rankOf = (p: string) => graph.fileRank.get(p) ?? 0;
    const byRankThenPath = (a: { path: string }, b: { path: string }) =>
      rankOf(b.path) - rankOf(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    const inboundOf = new Map<string, EdgeLine[]>();
    const outboundOf = new Map<string, EdgeLine[]>();
    for (const e of graph.edges) {
      if (!outboundOf.has(e.from)) outboundOf.set(e.from, []);
      outboundOf.get(e.from)!.push({ module: e.to, weight: e.weight });
      if (!inboundOf.has(e.to)) inboundOf.set(e.to, []);
      inboundOf.get(e.to)!.push({ module: e.from, weight: e.weight });
    }

    // ---- Stage 5: Pass B module summaries -------------------------------------
    const fileByPath = new Map(sourceFiles.map((f) => [f.path, f]));
    const buildTransientSkeletons = async (selected: IngestedFile[]) => {
      const contents = await sourceStore.getMany(selected.map((f) => f.blobSha));
      const rows = await Promise.all(
        selected.map(async (f) => {
          const cached = transientSkeletons.get(f.blobSha);
          if (cached) return { path: f.path, skeleton: cached };
          const content = contents.get(f.blobSha);
          if (!content) return null;
          const extraction = await extractStructure(f.language ?? "other", content);
          if (extraction.skeleton) transientSkeletons.set(f.blobSha, extraction.skeleton);
          return extraction.skeleton ? { path: f.path, skeleton: extraction.skeleton } : null;
        }),
      );
      return rows.filter((row): row is { path: string; skeleton: string } => row != null);
    };
    const buildModuleForSummary = (m: (typeof graph.modules)[number]): ModuleForSummary => {
      const members = m.filePaths
        .map((p) => fileByPath.get(p))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .sort(byRankThenPath);
      return {
        path: m.path,
        name: m.name,
        facts: m.facts,
        fileSummaries: members.map((f) => ({ path: f.path, summary: summaryOf(f.blobSha) })),
        topSymbols: members.slice(0, 10).map((f) => ({ path: f.path, symbols: symbolsOf(f.blobSha) })),
        inbound: inboundOf.get(m.path) ?? [],
        outbound: outboundOf.get(m.path) ?? [],
      };
    };

    const previousModules = await store.loadModules();
    const moduleRecordByPath = new Map(previousModules.map((m) => [m.path, m]));
    const moduleSummaryByPath = new Map<string, ModuleSummary>();
    const nextModules: ModuleRecord[] = [];
    {
      const need: ModuleForSummary[] = [];
      const hashOf = new Map<string, string>();
      for (const m of graph.modules) {
        const mfs = buildModuleForSummary(m);
        const memberShas = m.filePaths
          .map((p) => fileByPath.get(p)?.blobSha)
          .filter((s): s is string => !!s);
        const hash = moduleInputHash(mfs, memberShas);
        hashOf.set(m.path, hash);
        const record = moduleRecordByPath.get(m.path);
        if (
          record?.summary &&
          record.inputHash === hash &&
          record.summaryVersion === MODULE_SUMMARY_PROMPT_VERSION &&
          record.summaryModel === summaryModel
        ) {
          moduleSummaryByPath.set(m.path, record.summary);
        } else {
          // stale or missing: hand the model the old summary so it keeps
          // unchanged wording verbatim (stable downstream page hashes)
          if (record?.summary) mfs.previousSummary = record.summary;
          need.push(mfs);
        }
      }
      progress.stage(5, TOTAL_STAGES, `Summarizing modules (${need.length} of ${graph.modules.length})`);
      let done = 0;
      const batches = packModuleBatches(need);
      for (const [index, batch] of batches.entries()) {
        progress.tick(`batch ${index + 1}/${batches.length} (${done}/${need.length} modules)`);
        const results = await summarizeModuleBatch(repoHeader, batch, progress.usageSink);
        for (const [modulePath, summary] of results) moduleSummaryByPath.set(modulePath, summary);
        done += batch.length;
      }
      for (const m of graph.modules) {
        nextModules.push({
          path: m.path,
          name: m.name,
          facts: m.facts,
          summary: moduleSummaryByPath.get(m.path) ?? null,
          inputHash: hashOf.get(m.path) ?? null,
          summaryVersion: MODULE_SUMMARY_PROMPT_VERSION,
          summaryModel,
        });
      }
      await store.saveModules(nextModules);
    }

    // ---- Stage 6: Pass C plan --------------------------------------------------
    progress.stage(6, TOTAL_STAGES, "Planning the wiki");
    const readmeFile = analyzable.find((f) => /^readme\.(md|rst|txt)$/i.test(f.path));
    let readmeExcerpt: string | undefined;
    if (readmeFile) {
      const m = await sourceStore.getMany([readmeFile.blobSha]);
      readmeExcerpt = m.get(readmeFile.blobSha)?.slice(0, 12_000);
    }

    const moduleLines = graph.modules.map(
      (m) =>
        `${m.path || '""'} | ${m.name} | ${m.facts.fileCount} files | ${(moduleSummaryByPath.get(m.path)?.responsibilities ?? "").slice(0, 160)}`,
    );
    const moduleHashes = [...moduleSummaryByPath.entries()]
      .map(([p, s]) => inputHash({ p, r: s.responsibilities }))
      .sort();
    const planHash = inputHash({
      moduleHashes,
      manifestFacts,
      readmeHead: readmeExcerpt?.slice(0, 2000),
    });

    let architectureFacts = state.architectureFacts ?? "";
    const currentPages = await store.loadPages();
    const planUnchanged =
      state.lastPlanHash === planHash &&
      currentPages.some((p) => p.kind !== "section") &&
      architectureFacts !== "";

    let pages: PageRecord[];
    if (!planUnchanged) {
      // reconstruct the previous plan so C1/C2 can keep unchanged entries
      // byte-identical (otherwise reworded briefs regenerate every page)
      const previousPlan = (() => {
        const sections = currentPages
          .filter((p) => p.kind === "section")
          .sort((a, b) => a.position - b.position);
        if (sections.length === 0) return undefined;
        return {
          sections: sections.map((s) => ({
            title: s.title,
            slug: s.slug,
            pages: currentPages
              .filter((p) => p.parentSlug === s.slug && p.brief)
              .sort((a, b) => a.position - b.position)
              .map((p) => p.brief as PagePlan),
          })),
        };
      })();

      architectureFacts = await architectureBrief(
        repoHeader,
        {
          moduleLines,
          previousBrief: state.architectureFacts || undefined,
          edgeLines: graph.edges.map((e) => `${e.from || '""'} -> ${e.to || '""'} (${e.weight})`),
          manifestFacts,
          readmeExcerpt,
        },
        progress.usageSink,
      );

      const rawPlan = await planWiki(
        repoHeader,
        {
          brief: architectureFacts,
          moduleLines,
          manifestFacts,
          sourceFileCount: sourceFiles.length,
          allFilePaths: analyzable.map((f) => f.path),
          previousPlan,
        },
        progress.usageSink,
      ).catch((error: unknown) => {
        throw new Error(
          `The model could not produce a valid wiki plan. This usually means the model is ` +
            `too small for structured planning; try a larger one, e.g. --planner-model qwen3:14b. ` +
            `(${error instanceof Error ? error.message.slice(0, 300) : error})`,
        );
      });
      const { plan, warnings: planWarnings } = validatePlan(
        rawPlan,
        graph.modules.map((m) => m.path),
        new Map([...moduleSummaryByPath].map(([p, s]) => [p, s.responsibilities])),
        new Set(analyzable.map((f) => f.path)),
      );

      // Deterministic brief carry-over: the model is asked to keep unchanged
      // plan entries byte-identical but does not reliably comply, and a
      // reworded brief busts that page's input hash. When a page keeps the
      // same slug, kind and path scope, its previous brief wins outright.
      {
        const sameSet = (a: string[], b: string[]) =>
          a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
        const prevBySlug = new Map<string, PagePlan>();
        for (const s of previousPlan?.sections ?? []) {
          for (const p of s.pages) prevBySlug.set(p.slug, p);
        }
        for (const section of plan.sections) {
          for (let i = 0; i < section.pages.length; i++) {
            const cur = section.pages[i];
            const prev = prevBySlug.get(cur.slug);
            if (
              prev &&
              prev.kind === cur.kind &&
              sameSet(prev.module_paths, cur.module_paths) &&
              sameSet(prev.extra_paths, cur.extra_paths)
            ) {
              section.pages[i] = prev;
            }
          }
        }
      }

      const oldBySlug = new Map(currentPages.map((p) => [p.slug, p]));
      pages = [];
      let position = 0;
      for (const section of plan.sections) {
        pages.push({
          slug: section.slug,
          title: section.title,
          kind: "section",
          parentSlug: null,
          position: position++,
          brief: null,
          inputHash: null,
          stableInputHash: null,
          promptVersion: null,
          promptModel: null,
          status: "published",
          commitSha: null,
          warnings: [],
        });
        for (const page of section.pages) {
          const old = oldBySlug.get(page.slug);
          const oldMarkdown = old ? await store.loadPageMarkdown(page.slug) : null;
          pages.push({
            slug: page.slug,
            title: page.title,
            kind: page.kind,
            parentSlug: section.slug,
            position: position++,
            brief: page,
            // carry-over: unchanged pages stay published and skip regeneration.
            // promptVersion/promptModel MUST come along: the cheap update
            // tiers (skip, drift remap, patch mode) all gate on them, so
            // dropping them silently forces a full regen of every page.
            inputHash: oldMarkdown ? (old?.inputHash ?? null) : null,
            stableInputHash: oldMarkdown ? (old?.stableInputHash ?? null) : null,
            promptVersion: oldMarkdown ? (old?.promptVersion ?? 0) : 0,
            promptModel: oldMarkdown ? (old?.promptModel ?? null) : null,
            status: oldMarkdown ? (old?.status ?? "planned") : "planned",
            commitSha: old?.commitSha ?? null,
            warnings: old?.warnings ?? [],
          });
        }
      }
      // markdown files for slugs that fell out of the plan are removed at cutover
      state.lastPlanHash = planHash;
      state.architectureFacts = architectureFacts;
      state.planWarnings = planWarnings;
      await store.savePages(pages);
      await store.saveState({ ...state });
    } else {
      progress.line("wiki plan unchanged");
      pages = currentPages;
    }

    // ---- Stage 7: Pass D generation ---------------------------------------------
    const pageRows = pages.filter((p) => p.kind !== "section").sort((a, b) => a.position - b.position);
    const sectionTitleBySlug = new Map(
      pages.filter((p) => p.kind === "section").map((s) => [s.slug, s.title]),
    );
    const siblingPages = pageRows.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind }));

    const { mermaid: archMermaid, nodeIds } = moduleGraphToMermaid(graph);
    const originalNodeIds = new Set(nodeIds.values());

    const moduleDefByPath = new Map(graph.modules.map((m) => [m.path, m]));
    const moduleSummaryEntry = (path: string) => {
      const def = moduleDefByPath.get(path);
      const summary = moduleSummaryByPath.get(path);
      if (!def || !summary) return null;
      return { path, name: def.name, summary, facts: def.facts as ModuleFacts };
    };

    progress.stage(7, TOTAL_STAGES, `Generating pages (${pageRows.length})`);

    // symbol-aware citation validation map
    const citeMap = new Map(
      analyzable.map((f) => [f.path, { lineCount: f.lineCount, symbols: symbolsOf(f.blobSha) }]),
    );

    // infrastructure files (compose, dockerfiles, scripts, CI, env templates)
    // ground the operational pages with their full content
    const infraFiles = analyzable.filter((f) => INFRA_PATH_RE.test(f.path));
    const infraContents = await sourceStore.getMany(infraFiles.map((f) => f.blobSha));
    const infraSources = infraFiles
      .map((f) => ({ path: f.path, content: infraContents.get(f.blobSha) ?? "" }))
      .filter((s) => s.content !== "" && s.content.length < 24_000);

    const changedPages: Array<{ slug: string; title: string; kind: string }> = [];

    // module dir -> owning wiki page, so directory citations become links
    const moduleLinks = new Map<string, { slug: string; title: string }>();
    for (const p of pageRows) {
      if (!p.brief) continue;
      for (const mp of p.brief.module_paths) moduleLinks.set(mp, { slug: p.slug, title: p.title });
    }

    let pagesDone = 0;
    const processPage = async (page: PageRecord) => {
      const brief = page.brief;
      if (!brief) {
        pagesDone++;
        return;
      }

      const input: PageGenInput = {
        repoHeader,
        brief,
        sectionTitle: sectionTitleBySlug.get(page.parentSlug ?? "") ?? "",
        siblingPages: siblingPages.filter((s) => {
          if (s.slug === page.slug) return false;
          const other = pageRows.find((candidate) => candidate.slug === s.slug);
          return other?.parentSlug === page.parentSlug || s.kind === "overview" || s.kind === "architecture";
        }),
      };

      const scopedModulePaths = brief.module_paths;
      const scopedFiles = scopedModulePaths
        .flatMap((mp) => moduleDefByPath.get(mp)?.filePaths ?? [])
        .map((p) => fileByPath.get(p))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .sort(byRankThenPath);

      if (brief.kind === "module" || brief.kind === "subsystem-group") {
        input.moduleSummaries = scopedModulePaths
          .map(moduleSummaryEntry)
          .filter((x): x is NonNullable<typeof x> => !!x);
        input.fileSummaries = scopedFiles
          .map((f) => ({ path: f.path, summary: summaryOf(f.blobSha) }))
          .filter((x): x is { path: string; summary: FileSummary } => x.summary != null)
          .slice(0, 100);

        // top 2-3 files as FULL SOURCE (real grounding for walkthroughs and
        // quotable code), the next ones as skeletons
        const fullCount = brief.kind === "module" ? 3 : Math.min(scopedModulePaths.length, 3);
        const fullCandidates = scopedFiles
          .filter((f) => f.sizeBytes < FULL_SOURCE_MAX_CHARS)
          .slice(0, fullCount);
        const fullContents = await sourceStore.getMany(fullCandidates.map((f) => f.blobSha));
        input.fullSources = fullCandidates
          .map((f) => ({ path: f.path, content: fullContents.get(f.blobSha) ?? "" }))
          .filter((s) => s.content !== "");

        const topK = brief.kind === "module" ? 8 : Math.min(scopedModulePaths.length * 2, 10);
        input.skeletons = await buildTransientSkeletons(scopedFiles.slice(0, topK));
        input.roster = scopedFiles
          .slice(0, 40)
          .map((f) => ({ path: f.path, symbols: symbolsOf(f.blobSha) }));
        const agg = (map: Map<string, EdgeLine[]>) => {
          const acc = new Map<string, number>();
          for (const mp of scopedModulePaths) {
            for (const e of map.get(mp) ?? []) {
              if (scopedModulePaths.includes(e.module)) continue;
              acc.set(e.module, (acc.get(e.module) ?? 0) + e.weight);
            }
          }
          return [...acc.entries()].map(([module, weight]) => ({ module, weight }));
        };
        input.edges = { inbound: agg(inboundOf), outbound: agg(outboundOf) };
      } else if (brief.kind === "architecture") {
        input.moduleSummaries = graph.modules
          .slice(0, 60)
          .map((m) => moduleSummaryEntry(m.path))
          .filter((x): x is NonNullable<typeof x> => !!x);
        input.mermaid = archMermaid;
        input.architectureFacts = architectureFacts;
      } else if (brief.kind === "overview") {
        input.architectureFacts = architectureFacts;
        input.readmeExcerpt = readmeExcerpt;
        input.manifestFacts = manifestFacts;
        // ALL module summaries: entry points and flows must match the module pages
        input.moduleSummaries = graph.modules
          .slice(0, 60)
          .map((m) => moduleSummaryEntry(m.path))
          .filter((x): x is NonNullable<typeof x> => !!x);
      } else if (brief.kind === "getting-started") {
        input.readmeExcerpt = readmeExcerpt;
        input.manifestFacts = manifestFacts;
        input.fullSources = infraSources;
      } else {
        // configuration | data-model | api-reference | deployment | development | coverage
        input.manifestFacts = manifestFacts;
        input.architectureFacts = brief.kind === "development" ? architectureFacts : undefined;
        input.moduleSummaries = scopedModulePaths
          .map(moduleSummaryEntry)
          .filter((x): x is NonNullable<typeof x> => !!x);
        if (["configuration", "deployment", "development"].includes(brief.kind)) {
          input.fullSources = infraSources;
        }
        const extraFiles = brief.extra_paths
          .map((p) => analyzable.find((f) => f.path === p))
          .filter((f): f is NonNullable<typeof f> => !!f);
        const extraContents = await sourceStore.getMany(extraFiles.map((f) => f.blobSha));
        input.skeletons = extraFiles
          .map((f) => {
            const content = extraContents.get(f.blobSha);
            const body = content && content.length < 24_000 ? content : null;
            return body ? { path: f.path, skeleton: body } : null;
          })
          .filter((s): s is { path: string; skeleton: string } => !!s);
        input.roster = extraFiles.map((f) => ({ path: f.path, symbols: symbolsOf(f.blobSha) }));
      }

      const hash = pageInputHash(input);
      const stableHash = stablePageInputHash(input);
      const previousMarkdown = await store.loadPageMarkdown(page.slug);

      const persistPage = async (updates: Partial<PageRecord>, markdown?: string) => {
        Object.assign(page, updates);
        if (markdown !== undefined) await store.savePageMarkdown(page.slug, markdown);
        await store.savePages(pages);
      };

      if (
        page.inputHash === hash &&
        page.promptVersion === PROMPT_VERSION &&
        page.promptModel === pageModel &&
        page.status === "published" &&
        previousMarkdown
      ) {
        if (page.stableInputHash !== stableHash) {
          await persistPage({ stableInputHash: stableHash });
        }
        counts.skipped++;
        pagesDone++;
        progress.line(`${page.slug}: unchanged (${pagesDone}/${pageRows.length})`);
        return; // unchanged -> zero tokens
      }

      // Zero-LLM path: every prose-level input is identical (stable hash
      // matches) and only source content moved, so the page text is still
      // accurate; the citations just need re-anchoring to the moved symbols.
      if (
        previousMarkdown &&
        page.status === "published" &&
        page.stableInputHash != null &&
        page.stableInputHash === stableHash &&
        page.promptVersion === PROMPT_VERSION &&
        page.promptModel === pageModel
      ) {
        const citedPaths = new Set(
          [...previousMarkdown.matchAll(/\[\[cite:([^\]:]+)(?::\d+-\d+)?\]\]/g)].map((m) =>
            m[1].trim(),
          ),
        );
        const changedPaths = new Set(
          [...citedPaths].filter((p) => {
            const oldSha = oldShaByPath.get(p);
            const nowSha = fileByPath.get(p)?.blobSha;
            return oldSha != null && nowSha != null && oldSha !== nowSha;
          }),
        );
        const oldSymbolsByPath = new Map(
          [...changedPaths].map((p) => [p, symbolsOf(oldShaByPath.get(p)!)]),
        );
        const newSymbolsByPath = new Map(
          [...changedPaths].map((p) => [p, symbolsOf(fileByPath.get(p)!.blobSha)]),
        );
        const drift = remapCitationDrift({
          markdown: previousMarkdown,
          changedPaths,
          oldSymbolsByPath,
          newSymbolsByPath,
        });
        if (drift.ok) {
          const revalidated = validateAndCleanCitations(drift.markdown, citeMap, moduleLinks);
          if (revalidated.issues.length === 0) {
            await persistPage(
              { inputHash: hash, stableInputHash: stableHash, commitSha },
              revalidated.markdown,
            );
            counts.remapped++;
            pagesDone++;
            progress.line(
              `${page.slug}: ${drift.remapped} citation(s) re-anchored (${pagesDone}/${pageRows.length})`,
            );
            return;
          }
        }
      }

      // Patch-mode first: for an established page the model only writes the
      // sections that changed and we splice the rest from the previous
      // version byte-for-byte. Any doubt falls back to a full rewrite.
      const startedAt = Date.now();
      let rawMd: string | null = null;
      let outcome: "generated" | "patched" = "generated";
      if (
        previousMarkdown &&
        page.status === "published" &&
        page.promptVersion === PROMPT_VERSION &&
        page.promptModel === pageModel
      ) {
        // For an update, full content of UNCHANGED files adds little over
        // their skeleton (kept sections are spliced verbatim anyway), so
        // demote them and keep full source only for files that moved. The
        // canonical hashes above were computed on the unslimmed input, so
        // tier gating and next-sync comparisons are unaffected.
        const fileUnchanged = (p: string) => {
          const oldSha = oldShaByPath.get(p);
          const nowSha = fileByPath.get(p)?.blobSha;
          return oldSha != null && nowSha != null && oldSha === nowSha;
        };
        let updateInput = input;
        const staleFulls = (input.fullSources ?? []).filter((s) => fileUnchanged(s.path));
        if (staleFulls.length > 0) {
          const haveSkeleton = new Set((input.skeletons ?? []).map((s) => s.path));
          const demoted = await buildTransientSkeletons(
            staleFulls
              .filter((s) => !haveSkeleton.has(s.path))
              .map((s) => fileByPath.get(s.path))
              .filter((f): f is NonNullable<typeof f> => !!f),
          );
          updateInput = {
            ...input,
            fullSources: (input.fullSources ?? []).filter((s) => !fileUnchanged(s.path)),
            skeletons: [...(input.skeletons ?? []), ...demoted],
          };
        }
        const patched = await generatePageUpdateV2(updateInput, previousMarkdown, progress.usageSink);
        if (patched) {
          rawMd = patched.markdown;
          outcome = "patched";
        }
      }
      rawMd ??= await generatePageV2(input, progress.usageSink);
      const preflightCheck = validateAndCleanCitations(rawMd, citeMap, moduleLinks);
      const alwaysVerify = new Set([
        "overview",
        "architecture",
        "getting-started",
        "api-reference",
        "data-model",
        "deployment",
      ]).has(brief.kind);
      const sampled = parseInt(inputHash(`${commitSha}:${page.slug}`).slice(0, 8), 16) % 10 === 0;
      // full verify pass doubles a page's cost, so on incremental regens of an
      // already-published page it only runs when something is actually wrong
      // (citation issues) or sampled; the always-verify kinds get it on their
      // first generation
      const firstGeneration = !previousMarkdown;
      if (
        config.verify &&
        ((alwaysVerify && firstGeneration) || preflightCheck.issues.length > 0 || sampled)
      ) {
        rawMd = await verifyPageV2(input, rawMd, progress.usageSink);
      }
      let { markdown, issues } = validateAndCleanCitations(rawMd, citeMap, moduleLinks);
      markdown = stripEmDashes(markdown);

      // mermaid prune-only validation (architecture pages)
      if (brief.kind === "architecture") {
        markdown = markdown.replace(/```mermaid\n([\s\S]*?)```/g, (_whole, body: string) => {
          const validated = validatePrunedMermaid(body, originalNodeIds);
          return "```mermaid\n" + (validated ?? archMermaid) + "\n```";
        });
        if (!markdown.includes("```mermaid")) {
          markdown = markdown.replace(/^(# .+)$/m, `$1\n\n\`\`\`mermaid\n${archMermaid}\n\`\`\``);
        }
      }

      // A regeneration that lands on effectively the same text is NOT a
      // change: LLM re-emission jitters in whitespace and line wrapping. Keep
      // the previous bytes so the page stays stable across syncs, record no
      // revision, and leave it out of the changelog.
      const noOp =
        previousMarkdown != null && normalizePageText(markdown) === normalizePageText(previousMarkdown);
      if (!noOp) {
        changedPages.push({ slug: page.slug, title: page.title, kind: page.kind });
      }

      await persistPage(
        {
          inputHash: hash,
          stableInputHash: stableHash,
          promptVersion: PROMPT_VERSION,
          promptModel: pageModel,
          status: "published",
          commitSha,
          warnings: issues,
        },
        noOp ? previousMarkdown! : markdown,
      );

      counts[outcome === "patched" ? "patched" : "generated"]++;
      pagesDone++;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      progress.line(
        `${page.slug}: ${noOp ? "unchanged after regeneration" : outcome} (${seconds}s, ${pagesDone}/${pageRows.length})`,
      );
    };

    // two phases: module/detail pages first, then the synthesis pages
    // (overview, architecture) which must agree with them. The very first
    // page runs alone so model failures surface before the parallel wave.
    const synthesisKinds = new Set(["overview", "architecture"]);
    const detailPages = pageRows.filter((p) => !synthesisKinds.has(p.kind));
    const synthesisPages = pageRows.filter((p) => synthesisKinds.has(p.kind));
    if (detailPages.length > 0) await processPage(detailPages[0]);
    await runPool(detailPages.slice(1), 4, processPage);
    await runPool(synthesisPages, 2, processPage);

    // ---- Stage 8: changelog + cutover -------------------------------------------
    progress.stage(8, TOTAL_STAGES, "Finishing up");

    // changelog: auto release notes whenever pages changed
    // (skipped only on the very first index; everything is "new" then)
    if (changedPages.length > 0 && state.lastIndexedCommitSha) {
      const commitMoved = state.lastIndexedCommitSha !== commitSha;
      try {
        const summary = await chatText(
          `You write concise changelog entries for a code wiki that was just regenerated. Based on which documentation pages changed, write 2-6 short markdown bullets describing what parts of the codebase documentation were updated. Be specific and factual; mention page titles as [Title](/wiki/slug) links. No emojis, no fluff, no heading.`,
          `${
            commitMoved
              ? `Commits: ${state.lastIndexedCommitSha.slice(0, 7)} -> ${commitSha.slice(0, 7)}`
              : `The repository is unchanged (still at ${commitSha.slice(0, 7)}); the documentation itself was regenerated with improvements. Start the entry with one bullet saying the docs were refreshed without new commits.`
          }\nUpdated pages:\n${changedPages
            .map((p) => `- ${p.title} (${p.kind}, slug: ${p.slug})`)
            .join("\n")}`,
          { onUsage: progress.usageSink, maxTokens: 1024, temperature: 0.2 },
        );
        await store.appendChangelog({
          fromCommitSha: state.lastIndexedCommitSha,
          toCommitSha: commitSha,
          summary: stripEmDashes(summary.trim()),
          changedSlugs: changedPages.map((p) => p.slug),
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        progress.warn(`changelog entry failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // cutover: remove markdown for slugs that fell out of the plan, prune the
    // analysis cache to live blobs, and advance the state commit record LAST
    const liveSlugs = new Set(pages.map((p) => p.slug));
    for (const old of currentPages) {
      if (old.kind !== "section" && !liveSlugs.has(old.slug)) {
        await store.deletePageMarkdown(old.slug);
      }
    }
    await store.pruneAnalysis(new Set(analyzable.map((f) => f.blobSha)));
    state.lastIndexedCommitSha = commitSha;
    state.treeFingerprint = fingerprint;
    state.planVersion = previousState.planVersion + 1;
    await store.saveState(state);

    return { changed: true, commitSha, counts };
  } finally {
    await sourceStore.cleanup().catch(() => undefined);
  }
}
