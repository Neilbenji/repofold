// Deep-mode page generation: outline -> per-section calls with fact markers
// -> deterministic assembly with harness-resolved citations -> critique and
// targeted revision. Section bodies are cached with UNRESOLVED markers, so a
// pure citation drift re-assembles the page with zero model calls.
import { validateAndCleanCitations } from "../vendor/llm/passes.js";
import type { CiteFileInfo } from "../vendor/llm/passes.js";
import { normalizePageText, stripEmDashes } from "../vendor/llm/passes-v2.js";
import type { PagePlan } from "../vendor/llm/passes-v2.js";
import type { UsageSink } from "../vendor/llm/client.js";
import type { Fact, PageRecord, StateStore } from "../state.js";
import type { Progress } from "../progress.js";
import type { RepofoldConfig } from "../config.js";
import type { EtaTracker } from "./eta.js";
import type { FactIndex } from "./deep-stages.js";
import { fallbackOutline, outlineInputHash, planPageOutline, validateOutline, PageOutlineSchema, type PageOutline } from "./outline.js";
import {
  assembleDeepPage,
  generatePageIntro,
  generateSectionBody,
  relatedPagesBlock,
  resolveFactPlaceholders,
  sectionInputHash,
  type SectionContext,
} from "./sections.js";
import { critiquePage, MAX_REVISED_SECTIONS } from "./critique.js";
import { factStableProjection } from "./facts.js";

export const DEEP_PROMPT_VERSION = 1001;

/** Everything a page needs, prepared by the orchestrator per page kind. */
export type DeepPageInput = {
  page: PageRecord;
  brief: PagePlan;
  sectionTitle: string;
  siblings: Array<{ slug: string; title: string; kind: string }>;
  facts: Fact[];
  files: Array<{ path: string; lineCount: number | null; blobSha: string }>;
  /** loads full source for a path (scoped candidates only) */
  loadSource: (path: string) => Promise<string | null>;
  /** architecture page only */
  mermaid?: string;
};

export type DeepPageDeps = {
  config: RepofoldConfig;
  store: StateStore;
  progress: Progress;
  eta: EtaTracker;
  citeMap: Map<string, CiteFileInfo>;
  moduleLinks: Map<string, { slug: string; title: string }>;
  onUsage: UsageSink;
  commitSha: string;
};

export type DeepPageOutcome = {
  outcome: "generated" | "patched" | "remapped" | "skipped";
  markdown: string;
  changed: boolean;
  llmCalls: number;
};

const SOURCE_SLICE_MAX = 12_000;

export async function processPageDeep(
  input: DeepPageInput,
  deps: DeepPageDeps,
): Promise<DeepPageOutcome> {
  const { brief } = input;
  const factById = new Map(input.facts.map((f) => [f.id, f]));
  const factProjections = input.facts.map(factStableProjection).sort();
  const model = deps.config.model;
  let llmCalls = 0;

  // ---- outline (cached) ----
  const oHash = outlineInputHash({
    brief,
    factProjections,
    filePaths: input.files.map((f) => f.path).sort(),
    model,
  });
  let outline: PageOutline | null = null;
  const cachedOutline = await deps.store.loadOutline(brief.slug, oHash);
  if (cachedOutline) {
    try {
      outline = PageOutlineSchema.parse(JSON.parse(cachedOutline));
    } catch {
      outline = null;
    }
  }
  if (!outline) {
    try {
      const raw = await planPageOutline(
        { brief, sectionTitle: input.sectionTitle, facts: input.facts, files: input.files },
        deps.onUsage,
      );
      llmCalls++;
      outline = validateOutline(raw, input.facts, brief, input.files);
    } catch {
      outline = null;
    }
    outline ??= fallbackOutline(brief, input.facts, input.files);
    await deps.store.saveOutline(brief.slug, oHash, JSON.stringify(outline));
  }

  // ---- sections (cached, bodies keep unresolved [[f:ID]] markers) ----
  const headings = outline.sections.map((s) => s.heading);
  const sectionResults: Array<{ heading: string; body: string; hash: string; fresh: boolean }> = [];
  for (const section of outline.sections) {
    const sectionFacts = section.fact_ids
      .map((id) => factById.get(id))
      .filter((f): f is Fact => !!f);
    const sources: Array<{ path: string; content: string }> = [];
    for (const p of section.full_source_paths) {
      const content = await input.loadSource(p);
      if (content && content.length <= SOURCE_SLICE_MAX) sources.push({ path: p, content });
    }
    const ctx: SectionContext = {
      brief,
      heading: section.heading,
      scope: section.scope,
      questions: section.question_idx.map((i) => brief.questions[i]).filter(Boolean),
      facts: sectionFacts,
      sources,
      otherSections: outline.sections
        .filter((s) => s.heading !== section.heading)
        .map((s) => ({ heading: s.heading, scope: s.scope })),
    };
    const hash = sectionInputHash({
      model,
      brief,
      heading: section.heading,
      scope: section.scope,
      questions: ctx.questions,
      factProjections: sectionFacts.map(factStableProjection).sort(),
      sourceBlobShas: section.full_source_paths
        .map((p) => input.files.find((f) => f.path === p)?.blobSha ?? "")
        .sort(),
      otherHeadings: headings.filter((h) => h !== section.heading),
    });
    let body = await deps.store.loadSection(brief.slug, hash);
    let fresh = false;
    if (body == null) {
      const started = Date.now();
      try {
        body = await generateSectionBody(ctx, deps.onUsage);
        llmCalls++;
      } catch (err) {
        deps.progress.warn(
          `section "${section.heading}" of ${brief.slug} failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
        );
        body = "";
      }
      deps.eta.record("section", Date.now() - started);
      fresh = true;
      if (body) await deps.store.saveSection(brief.slug, hash, body);
    }
    sectionResults.push({ heading: section.heading, body: body ?? "", hash, fresh });
  }

  // ---- intro (cached) ----
  const introHash = sectionInputHash({
    model,
    brief,
    heading: "__intro__",
    scope: "",
    questions: [],
    factProjections: [],
    sourceBlobShas: [],
    otherHeadings: headings,
  });
  let intro = await deps.store.loadSection(brief.slug, `intro-${introHash}`);
  let introFresh = false;
  if (intro == null) {
    try {
      intro = await generatePageIntro({ brief, sectionHeadings: headings }, deps.onUsage);
      llmCalls++;
    } catch {
      intro = `# ${brief.title}`;
    }
    introFresh = true;
    await deps.store.saveSection(brief.slug, `intro-${introHash}`, intro);
  }

  const anyFresh = introFresh || sectionResults.some((s) => s.fresh);
  const allCached = !anyFresh;

  // ---- assemble: resolve markers against CURRENT fact lines ----
  const assemble = () => {
    const resolvedSections = sectionResults.map((s) => ({
      heading: s.heading,
      body: resolveFactPlaceholders(s.body, factById).markdown,
    }));
    const raw = assembleDeepPage({
      intro: resolveFactPlaceholders(intro!, factById).markdown,
      sections: resolvedSections,
      mermaid: input.mermaid,
      related: relatedPagesBlock(input.siblings, brief.slug),
    });
    const cleaned = validateAndCleanCitations(raw, deps.citeMap, deps.moduleLinks);
    return { markdown: stripEmDashes(cleaned.markdown), issues: cleaned.issues };
  };
  let { markdown, issues } = assemble();

  // ---- critique -> revise (only when something was regenerated) ----
  if (anyFresh && deps.config.verify) {
    try {
      const issuesFound = await critiquePage(
        { brief, sectionHeadings: headings, markdown },
        deps.onUsage,
      );
      llmCalls++;
      const toRevise = issuesFound.slice(0, MAX_REVISED_SECTIONS);
      for (const issue of toRevise) {
        const target = sectionResults.find((s) => s.heading === issue.section);
        const outlineSection = outline.sections.find((s) => s.heading === issue.section);
        if (!target || !outlineSection) continue;
        const sectionFacts = outlineSection.fact_ids
          .map((id) => factById.get(id))
          .filter((f): f is Fact => !!f);
        const sources: Array<{ path: string; content: string }> = [];
        for (const p of outlineSection.full_source_paths) {
          const content = await input.loadSource(p);
          if (content && content.length <= SOURCE_SLICE_MAX) sources.push({ path: p, content });
        }
        try {
          const revised = await generateSectionBody(
            {
              brief,
              heading: target.heading,
              scope: outlineSection.scope,
              questions: outlineSection.question_idx.map((i) => brief.questions[i]).filter(Boolean),
              facts: sectionFacts,
              sources,
              otherSections: outline.sections
                .filter((s) => s.heading !== target.heading)
                .map((s) => ({ heading: s.heading, scope: s.scope })),
              feedback: `${issue.problem}: ${issue.detail}`,
            },
            deps.onUsage,
          );
          llmCalls++;
          // accept only if the revision does not lose citations
          const before = (resolveFactPlaceholders(target.body, factById).markdown.match(/\[\[cite:/g) ?? []).length;
          const after = (resolveFactPlaceholders(revised, factById).markdown.match(/\[\[cite:/g) ?? []).length;
          if (revised.trim() && after >= before) {
            target.body = revised;
            await deps.store.saveSection(brief.slug, target.hash, revised);
          }
        } catch {
          // keep the original section
        }
      }
      if (toRevise.length > 0) ({ markdown, issues } = assemble());
    } catch (err) {
      deps.progress.warn(
        `critique skipped for ${brief.slug}: ${err instanceof Error ? err.message.slice(0, 160) : err}`,
      );
    }
  }

  // ---- outcome vs previous version ----
  const previous = await deps.store.loadPageMarkdown(brief.slug);
  const identical = previous != null && normalizePageText(markdown) === normalizePageText(previous);
  let outcome: DeepPageOutcome["outcome"];
  if (allCached) outcome = identical ? "skipped" : "remapped";
  else if (sectionResults.some((s) => !s.fresh)) outcome = identical ? "skipped" : "patched";
  else outcome = identical ? "skipped" : "generated";

  // prune stale cached sections for this slug
  const keep = new Set<string>([...sectionResults.map((s) => s.hash), `intro-${introHash}`, oHash]);
  await deps.store.pruneSections(brief.slug, keep);

  // record for the page store
  input.page.warnings = issues;
  return { outcome, markdown: identical && previous ? previous : markdown, changed: !identical, llmCalls };
}
