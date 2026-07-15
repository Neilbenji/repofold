// L3 step 1: plan the H2 sections of one page. The outline call assigns each
// fact and each brief question to exactly one section. A deterministic
// fallback per page kind guarantees an outline failure never sinks a page.
import { z } from "zod";
import { chatJson } from "../vendor/llm/client.js";
import type { UsageSink } from "../vendor/llm/client.js";
import { inputHash } from "../vendor/llm/passes.js";
import type { PagePlan } from "../vendor/llm/passes-v2.js";
import type { Fact } from "../state.js";

export const OUTLINE_VERSION = 1;

export const PageOutlineSchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string(),
      scope: z.string().default(""),
      question_idx: z.array(z.number()).default([]),
      fact_ids: z.array(z.string()).default([]),
      full_source_paths: z.array(z.string()).default([]),
    }),
  ),
});
export type PageOutline = z.infer<typeof PageOutlineSchema>;

const SYSTEM = `You plan the H2 sections of one documentation wiki page. Respond with ONLY a JSON object:
{"sections":[{"heading":"...","scope":"one sentence: what this section covers","question_idx":[0,2],"fact_ids":["3a9c1f"],"full_source_paths":["src/x.ts"]}]}
Rules:
- 3 to 8 sections, ordered for a reader who is new to the codebase.
- Assign every fact id and every question index to EXACTLY ONE section.
- At most 2 full_source_paths per section, chosen only from FILES.
- Headings are concrete and specific; never "Introduction", "Overview" or "Conclusion".
- No emojis.`;

export async function planPageOutline(
  input: {
    brief: PagePlan;
    sectionTitle: string;
    facts: Fact[];
    files: Array<{ path: string; lineCount: number | null }>;
  },
  onUsage?: UsageSink,
): Promise<PageOutline> {
  const user = [
    `PAGE: "${input.brief.title}" (kind: ${input.brief.kind}, section: "${input.sectionTitle}")`,
    input.brief.description ? `SCOPE: ${input.brief.description}` : "",
    input.brief.questions.length
      ? `QUESTIONS:\n${input.brief.questions.map((q, i) => `${i}: ${q}`).join("\n")}`
      : "QUESTIONS: none",
    input.facts.length
      ? `FACTS:\n${input.facts.map((f) => `[${f.id}] (${f.path}, ${f.symbol}) ${f.text}`).join("\n")}`
      : "FACTS: none",
    `FILES:\n${input.files.map((f) => `- ${f.path}${f.lineCount ? ` (${f.lineCount} lines)` : ""}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await chatJson(SYSTEM, user, PageOutlineSchema, {
    maxTokens: 2000,
    temperature: 0.2,
    onUsage,
  });
  return raw;
}

/**
 * Enforces the outline invariants deterministically: unique headings, every
 * fact/question in exactly one section (first assignment wins; unassigned
 * items land on the best-matching or last section), valid file paths, caps.
 */
export function validateOutline(
  raw: PageOutline,
  facts: Fact[],
  brief: PagePlan,
  files: Array<{ path: string }>,
): PageOutline | null {
  if (raw.sections.length < 2 || raw.sections.length > 10) return null;
  const validPaths = new Set(files.map((f) => f.path));
  const knownFactIds = new Set(facts.map((f) => f.id));
  const seenHeadings = new Set<string>();
  const seenFacts = new Set<string>();
  const seenQuestions = new Set<number>();

  const sections = raw.sections
    .map((s) => {
      const heading = s.heading.trim().replace(/^#+\s*/, "");
      if (!heading || seenHeadings.has(heading.toLowerCase())) return null;
      seenHeadings.add(heading.toLowerCase());
      const fact_ids = s.fact_ids.filter((id) => {
        if (!knownFactIds.has(id) || seenFacts.has(id)) return false;
        seenFacts.add(id);
        return true;
      });
      const question_idx = s.question_idx.filter((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= brief.questions.length || seenQuestions.has(i))
          return false;
        seenQuestions.add(i);
        return true;
      });
      return {
        heading,
        scope: s.scope.trim(),
        question_idx,
        fact_ids,
        full_source_paths: s.full_source_paths.filter((p) => validPaths.has(p)).slice(0, 2),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s != null)
    .slice(0, 8);
  if (sections.length < 2) return null;

  // Unassigned facts: attach to the section citing the same file, else the last.
  for (const fact of facts) {
    if (seenFacts.has(fact.id)) continue;
    const target =
      sections.find((s) =>
        s.fact_ids.some((id) => facts.find((f) => f.id === id)?.path === fact.path),
      ) ??
      sections.find((s) => s.full_source_paths.includes(fact.path)) ??
      sections[sections.length - 1];
    target.fact_ids.push(fact.id);
  }
  // Unassigned questions: append to the last section.
  for (let i = 0; i < brief.questions.length; i++) {
    if (!seenQuestions.has(i)) sections[sections.length - 1].question_idx.push(i);
  }
  return { sections };
}

const KIND_SECTIONS: Record<string, string[]> = {
  module: ["Purpose", "How it works", "Main flows", "Public API", "Configuration and conventions"],
  "subsystem-group": ["What these modules do", "How they relate", "Public API"],
  overview: ["What the project is", "Feature tour", "Tech stack", "Where to go next"],
  architecture: ["System shape", "Key flows", "Module responsibilities"],
  "getting-started": ["Prerequisites", "Installation", "Configuration", "Running it", "Verifying it works"],
  configuration: ["Configuration files", "Environment variables", "Defaults and overrides"],
  "data-model": ["Entities", "Relationships", "Lifecycle"],
  "api-reference": ["Exports and entry points", "Core functions", "Types"],
  deployment: ["Build", "Containerization", "CI/CD pipeline"],
  development: ["Repository layout", "Scripts and tooling", "Testing", "Conventions"],
  coverage: ["Documented areas", "Excluded files"],
};

/** Deterministic fallback: fixed headings per kind, facts spread by file. */
export function fallbackOutline(
  brief: PagePlan,
  facts: Fact[],
  files: Array<{ path: string }>,
): PageOutline {
  const headings = KIND_SECTIONS[brief.kind] ?? ["Purpose", "How it works", "Details"];
  const sections: PageOutline["sections"] = headings.map((heading) => ({
    heading,
    scope: "",
    question_idx: [],
    fact_ids: [],
    full_source_paths: [],
  }));
  // Facts: purpose-ish facts to the first section, the rest round-robin over
  // the middle sections grouped by file so related facts stay together.
  const byFile = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!byFile.has(f.path)) byFile.set(f.path, []);
    byFile.get(f.path)!.push(f);
  }
  const middle = sections.slice(1, Math.max(2, sections.length - 1));
  let slot = 0;
  for (const group of byFile.values()) {
    const target = middle[slot % middle.length] ?? sections[0];
    target.fact_ids.push(...group.map((f) => f.id));
    slot++;
  }
  // Questions round-robin, full sources to the second section.
  for (let i = 0; i < brief.questions.length; i++) {
    sections[(i % Math.max(1, sections.length - 1)) + 0].question_idx.push(i);
  }
  const paths = files.slice(0, 2).map((f) => f.path);
  if (sections.length > 1) sections[1].full_source_paths = paths;
  return { sections };
}

export function outlineInputHash(input: {
  brief: PagePlan;
  factProjections: string[];
  filePaths: string[];
  model: string;
}): string {
  return inputHash({
    OUTLINE_VERSION,
    model: input.model,
    brief: input.brief,
    facts: input.factProjections,
    files: input.filePaths,
  });
}
