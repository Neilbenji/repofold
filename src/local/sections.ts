// L3 steps 2-4: generate section bodies with fact markers, generate the page
// intro, resolve markers to real citations, and assemble the page.
import { chatText } from "../vendor/llm/client.js";
import type { UsageSink } from "../vendor/llm/client.js";
import { inputHash } from "../vendor/llm/passes.js";
import type { PagePlan } from "../vendor/llm/passes-v2.js";
import type { Fact } from "../state.js";
import { renderFactBlock } from "./facts.js";
import type { PageOutline } from "./outline.js";

export const SECTION_VERSION = 2;

const SECTION_SYSTEM = `You write ONE section body of a documentation wiki page. Rules:
- Output plain markdown BODY only: no H1 or H2 heading, no sentences about "this section" or "this page", no introduction or conclusion.
- Weave the given FACTS into flowing prose. When a sentence states a fact, end it with that fact's marker copied EXACTLY as given, e.g. [[f:3a9c1f]]. Use every fact at least once. Use ONLY markers that were given to you; never invent markers or citations.
- You may quote short snippets from SOURCE in fenced code blocks and use tables for API surfaces (H3 subheadings are allowed).
- Answer the assigned QUESTIONS explicitly in the prose.
- Ground everything in the given FACTS and SOURCE. When they do not support a topic, write less instead of inventing details; never fabricate commands, paths, errors, or behavior.
- Do not cover the topics listed under COVERED ELSEWHERE.
- Professional, factual tone. No em dashes. No emojis. English only.`;

export type SectionContext = {
  brief: PagePlan;
  heading: string;
  scope: string;
  questions: string[];
  facts: Fact[];
  sources: Array<{ path: string; content: string }>;
  otherSections: Array<{ heading: string; scope: string }>;
  feedback?: string;
};

export async function generateSectionBody(
  ctx: SectionContext,
  onUsage?: UsageSink,
): Promise<string> {
  const user = [
    `PAGE: "${ctx.brief.title}" (kind: ${ctx.brief.kind}) — SECTION: "${ctx.heading}"`,
    ctx.scope ? `SECTION SCOPE: ${ctx.scope}` : "",
    ctx.questions.length ? `QUESTIONS:\n${ctx.questions.map((q) => `- ${q}`).join("\n")}` : "",
    ctx.facts.length ? `FACTS:\n${renderFactBlock(ctx.facts)}` : "FACTS: none provided",
    ...ctx.sources.map((s) => `SOURCE (${s.path}):\n${s.content}`),
    ctx.otherSections.length
      ? `COVERED ELSEWHERE:\n${ctx.otherSections.map((s) => `- ${s.heading}${s.scope ? `: ${s.scope}` : ""}`).join("\n")}`
      : "",
    ctx.feedback ? `FEEDBACK on the previous version of this section, address it:\n${ctx.feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = await chatText(SECTION_SYSTEM, user, {
    maxTokens: 1400,
    temperature: 0.3,
    onUsage,
  });
  // strip any headings the model emitted despite instructions
  return body.replace(/^#{1,2}\s.*$/gm, "").trim();
}

const INTRO_SYSTEM = `You write the opening of a documentation wiki page: exactly one H1 heading line ("# <title>") followed by one short paragraph (2-4 sentences) framing what the page covers, written for a developer new to the codebase. Nothing else: no lists, no further headings, no links. No em dashes, no emojis. English only.`;

export async function generatePageIntro(
  input: { brief: PagePlan; sectionHeadings: string[] },
  onUsage?: UsageSink,
): Promise<string> {
  const user = [
    `PAGE TITLE: ${input.brief.title}`,
    input.brief.description ? `PAGE SCOPE: ${input.brief.description}` : "",
    `SECTIONS ON THIS PAGE:\n${input.sectionHeadings.map((h) => `- ${h}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const intro = (await chatText(INTRO_SYSTEM, user, { maxTokens: 1000, temperature: 0.3, onUsage })).trim();
  return intro.startsWith("#") ? intro : `# ${input.brief.title}\n\n${intro}`;
}

/**
 * Substitutes [[f:ID]] markers with real [[cite:path:S-E]] tokens from the
 * fact store (current line numbers). Unknown or out-of-scope markers are
 * stripped. Also tolerates the model writing [f:ID] or f:ID inside brackets.
 */
export function resolveFactPlaceholders(
  markdown: string,
  factById: Map<string, Fact>,
): { markdown: string; unknown: string[] } {
  const unknown: string[] = [];
  // match ANY f:-shaped marker: models invent ids ("[[f:error-handling]]");
  // unknown markers are stripped so fabricated anchors never reach readers
  const resolved = markdown.replace(
    /\[?\[\[?f:([^\]\s]{1,60})\]?\]\]?/gi,
    (_whole, id: string) => {
      const fact = factById.get(id.toLowerCase());
      if (!fact) {
        unknown.push(id);
        return "";
      }
      // file-level facts (no symbol range) cite the path without lines
      if (fact.startLine === 0) return `[[cite:${fact.path}]]`;
      return `[[cite:${fact.path}:${fact.startLine}-${fact.endLine}]]`;
    },
  );
  // tidy doubled spaces left by stripped markers
  return { markdown: resolved.replace(/ +([.,;:])/g, "$1").replace(/ {2,}/g, " "), unknown };
}

/** Deterministic related-pages block: the model never writes wiki links. */
export function relatedPagesBlock(
  siblings: Array<{ slug: string; title: string; kind: string }>,
  selfSlug: string,
): string {
  const links = siblings
    .filter((s) => s.slug !== selfSlug)
    .slice(0, 6)
    .map((s) => `- [${s.title}](/wiki/${s.slug})`);
  return links.length ? `## Related pages\n\n${links.join("\n")}` : "";
}

export function assembleDeepPage(input: {
  intro: string;
  sections: Array<{ heading: string; body: string }>;
  mermaid?: string;
  related: string;
}): string {
  const parts: string[] = [input.intro.trim()];
  if (input.mermaid) parts.push("```mermaid\n" + input.mermaid + "\n```");
  for (const section of input.sections) {
    if (!section.body.trim()) continue;
    parts.push(`## ${section.heading}\n\n${section.body.trim()}`);
  }
  if (input.related) parts.push(input.related);
  return parts.join("\n\n") + "\n";
}

/** Cache key for one section: stable fact projections, never line numbers. */
export function sectionInputHash(input: {
  model: string;
  brief: PagePlan;
  heading: string;
  scope: string;
  questions: string[];
  factProjections: string[];
  sourceBlobShas: string[];
  otherHeadings: string[];
  feedback?: string;
}): string {
  return inputHash({ SECTION_VERSION, ...input });
}
