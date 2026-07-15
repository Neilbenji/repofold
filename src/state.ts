// Filesystem persistence for the pipeline: the local counterpart of the
// cloud's Postgres tables. Everything lives under <repo>/.repofold/.
// Writes are atomic (tmp + rename); state.json is only advanced at cutover,
// so an interrupted run resumes idempotently through the hash gates.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Symbol } from "./vendor/pipeline/treesitter.js";
import type { ModuleFacts } from "./vendor/pipeline/modules.js";
import type { FileSummary, CiteIssue } from "./vendor/llm/passes.js";
import type { ModuleSummary, PagePlan } from "./vendor/llm/passes-v2.js";
import type { FileKind } from "./vendor/pipeline/filter.js";

export const STATE_SCHEMA_VERSION = 1;

export type FileRecord = {
  path: string;
  language: string | null;
  kind: FileKind;
  blobSha: string;
  sizeBytes: number;
  lineCount: number | null;
};

export type AnalysisRecord = {
  symbols: Symbol[];
  imports: string[];
  summary: FileSummary | null;
  summaryVersion: number | null;
  summaryModel: string | null;
  // Deep mode keeps its richer summary in separate fields so fast and deep
  // runs never invalidate each other's caches.
  deepSummary?: DeepFileSummary | null;
  deepSummaryVersion?: number | null;
  deepSummaryModel?: string | null;
};

/** Structured per-file summary produced by the deep pass (src/local). */
export type DeepFileSummary = {
  purpose: string;
  key_symbols: Array<{ name: string; role: string }>;
  main_flows: string[];
  gotchas: string[];
  config_keys: string[];
};

/** A mined, harness-cited claim about one symbol (deep mode). */
export type Fact = {
  id: string;
  text: string;
  path: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
};

export type FactsRecord = {
  version: number;
  model: string;
  facts: Fact[];
};

export type ModuleRecord = {
  path: string;
  name: string;
  facts: ModuleFacts;
  summary: ModuleSummary | null;
  inputHash: string | null;
  summaryVersion: number | null;
  summaryModel: string | null;
};

export type PageRecord = {
  slug: string;
  title: string;
  kind: string;
  parentSlug: string | null;
  position: number;
  brief: PagePlan | null;
  inputHash: string | null;
  stableInputHash: string | null;
  promptVersion: number | null;
  promptModel: string | null;
  status: "planned" | "generating" | "published" | "error";
  commitSha: string | null;
  warnings: CiteIssue[];
};

export type ChangelogEntry = {
  fromCommitSha: string;
  toCommitSha: string;
  summary: string;
  changedSlugs: string[];
  createdAt: string;
};

export type RepoState = {
  schemaVersion: number;
  lastIndexedCommitSha: string | null;
  treeFingerprint: string | null;
  planVersion: number;
  lastPlanHash: string | null;
  architectureFacts: string | null;
  planWarnings: string[];
  ignoreGlobs: string[];
  model: string | null;
  plannerModel: string | null;
  inputBudget: number | null;
  /** EWMA latency per pass type, seeds the deep-mode ETA across runs. */
  avgCallMsByPass?: Record<string, number>;
};

export function emptyState(): RepoState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastIndexedCommitSha: null,
    treeFingerprint: null,
    planVersion: 0,
    lastPlanHash: null,
    architectureFacts: null,
    planWarnings: [],
    ignoreGlobs: [],
    model: null,
    plannerModel: null,
    inputBudget: null,
  };
}

/** Detects working-tree changes even when HEAD has not moved. */
export function treeFingerprint(files: Array<{ path: string; blobSha: string }>): string {
  const lines = files
    .map((f) => `${f.path}:${f.blobSha}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(lines).digest("hex");
}

async function writeAtomic(target: string, data: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, target);
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Page markdown lives in per-slug files; slugs may contain "/". */
function pageFile(dir: string, slug: string): string {
  return path.join(dir, "pages", `${slug}.md`);
}

export class StateStore {
  constructor(readonly dir: string) {}

  async load(): Promise<RepoState> {
    const state = await readJson<RepoState>(path.join(this.dir, "state.json"));
    if (state && state.schemaVersion === STATE_SCHEMA_VERSION) return state;
    return emptyState();
  }

  /** Written LAST in a run: advancing this commits the run. */
  async saveState(state: RepoState): Promise<void> {
    await writeAtomic(path.join(this.dir, "state.json"), JSON.stringify(state, null, 2));
  }

  async loadFiles(): Promise<FileRecord[]> {
    return (await readJson<FileRecord[]>(path.join(this.dir, "files.json"))) ?? [];
  }

  async saveFiles(files: FileRecord[]): Promise<void> {
    await writeAtomic(path.join(this.dir, "files.json"), JSON.stringify(files));
  }

  async loadAnalysis(blobSha: string): Promise<AnalysisRecord | null> {
    if (!/^[0-9a-f]{40}$/.test(blobSha)) return null;
    return readJson<AnalysisRecord>(path.join(this.dir, "analysis", `${blobSha}.json`));
  }

  async saveAnalysis(blobSha: string, record: AnalysisRecord): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error(`Invalid blob sha: ${blobSha}`);
    await writeAtomic(path.join(this.dir, "analysis", `${blobSha}.json`), JSON.stringify(record));
  }

  async listAnalysisShas(): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.dir, "analysis"));
      return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -5));
    } catch {
      return [];
    }
  }

  async pruneAnalysis(liveShas: Set<string>): Promise<number> {
    let pruned = 0;
    for (const sha of await this.listAnalysisShas()) {
      if (!liveShas.has(sha)) {
        await rm(path.join(this.dir, "analysis", `${sha}.json`), { force: true });
        pruned++;
      }
    }
    return pruned;
  }

  async loadFacts(blobSha: string): Promise<FactsRecord | null> {
    if (!/^[0-9a-f]{40}$/.test(blobSha)) return null;
    return readJson<FactsRecord>(path.join(this.dir, "facts", `${blobSha}.json`));
  }

  async saveFacts(blobSha: string, record: FactsRecord): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error(`Invalid blob sha: ${blobSha}`);
    await writeAtomic(path.join(this.dir, "facts", `${blobSha}.json`), JSON.stringify(record));
  }

  async pruneFacts(liveShas: Set<string>): Promise<number> {
    let pruned = 0;
    let entries: string[];
    try {
      entries = await readdir(path.join(this.dir, "facts"));
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const sha = entry.slice(0, -5);
      if (!liveShas.has(sha)) {
        await rm(path.join(this.dir, "facts", entry), { force: true });
        pruned++;
      }
    }
    return pruned;
  }

  async loadSection(slug: string, hash: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir, "sections", slug, `${hash}.md`), "utf8");
    } catch {
      return null;
    }
  }

  async saveSection(slug: string, hash: string, markdown: string): Promise<void> {
    await writeAtomic(path.join(this.dir, "sections", slug, `${hash}.md`), markdown);
  }

  async loadOutline(slug: string, hash: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir, "sections", slug, `outline-${hash}.json`), "utf8");
    } catch {
      return null;
    }
  }

  async saveOutline(slug: string, hash: string, json: string): Promise<void> {
    await writeAtomic(path.join(this.dir, "sections", slug, `outline-${hash}.json`), json);
  }

  async pruneSections(slug: string, keep: Set<string>): Promise<void> {
    const dir = path.join(this.dir, "sections", slug);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const stem = entry.replace(/\.(md|json)$/, "").replace(/^outline-/, "");
      if (!keep.has(stem)) await rm(path.join(dir, entry), { force: true });
    }
  }

  async deleteSections(slug: string): Promise<void> {
    await rm(path.join(this.dir, "sections", slug), { recursive: true, force: true });
  }

  async loadModules(): Promise<ModuleRecord[]> {
    return (await readJson<ModuleRecord[]>(path.join(this.dir, "modules.json"))) ?? [];
  }

  async saveModules(modules: ModuleRecord[]): Promise<void> {
    await writeAtomic(path.join(this.dir, "modules.json"), JSON.stringify(modules));
  }

  async loadPages(): Promise<PageRecord[]> {
    return (await readJson<PageRecord[]>(path.join(this.dir, "pages.json"))) ?? [];
  }

  async savePages(pages: PageRecord[]): Promise<void> {
    await writeAtomic(path.join(this.dir, "pages.json"), JSON.stringify(pages, null, 1));
  }

  async loadPageMarkdown(slug: string): Promise<string | null> {
    try {
      return await readFile(pageFile(this.dir, slug), "utf8");
    } catch {
      return null;
    }
  }

  async savePageMarkdown(slug: string, markdown: string): Promise<void> {
    await writeAtomic(pageFile(this.dir, slug), markdown);
  }

  async deletePageMarkdown(slug: string): Promise<void> {
    await rm(pageFile(this.dir, slug), { force: true });
  }

  async loadChangelog(): Promise<ChangelogEntry[]> {
    return (await readJson<ChangelogEntry[]>(path.join(this.dir, "changelog.json"))) ?? [];
  }

  async appendChangelog(entry: ChangelogEntry): Promise<void> {
    const entries = await this.loadChangelog();
    entries.push(entry);
    await writeAtomic(path.join(this.dir, "changelog.json"), JSON.stringify(entries, null, 1));
  }

  async wipe(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
