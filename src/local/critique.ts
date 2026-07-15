// L4: critique the assembled page against a rubric and revise the worst
// sections. Replaces the cloud verify pass in deep mode with 100% coverage.
import { z } from "zod";
import { chatJson } from "../vendor/llm/client.js";
import type { UsageSink } from "../vendor/llm/client.js";
import type { PagePlan } from "../vendor/llm/passes-v2.js";

export const CritiqueSchema = z.object({
  issues: z
    .array(
      z.object({
        section: z.string(),
        problem: z.string(),
        detail: z.string().default(""),
        severity: z.number().default(1),
      }),
    )
    .default([]),
});
export type SectionIssue = z.infer<typeof CritiqueSchema>["issues"][number];

const SYSTEM = `You review one documentation wiki page against a rubric. Respond with ONLY a JSON object:
{"issues":[{"section":"exact H2 heading","problem":"unanswered_question|uncited_claim|repetition|listing_not_prose|contradiction","detail":"one sentence","severity":1}]}
severity: 3 = badly wrong, 2 = clearly weak, 1 = minor. At most 6 issues, most severe first. Empty issues array when the page is good. Only report real problems; do not invent issues. No emojis.`;

export const MAX_REVISED_SECTIONS = 3;

export async function critiquePage(
  input: { brief: PagePlan; sectionHeadings: string[]; markdown: string },
  onUsage?: UsageSink,
): Promise<SectionIssue[]> {
  const user = [
    `PAGE: "${input.brief.title}" (kind: ${input.brief.kind})`,
    input.brief.questions.length
      ? `THE PAGE MUST ANSWER:\n${input.brief.questions.map((q) => `- ${q}`).join("\n")}`
      : "",
    `SECTION HEADINGS: ${input.sectionHeadings.join(" | ")}`,
    `PAGE:\n${input.markdown}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // generous cap: reasoning models think at length before a full-page review
  const parsed = await chatJson(SYSTEM, user, CritiqueSchema, {
    maxTokens: 4000,
    temperature: 0.2,
    onUsage,
  });
  return parsed.issues
    .filter((issue) => input.sectionHeadings.some((h) => h === issue.section))
    .sort((a, b) => b.severity - a.severity);
}
