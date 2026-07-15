import { test } from "node:test";
import assert from "node:assert/strict";
import type { Symbol } from "../src/vendor/pipeline/treesitter.js";
import type { Fact } from "../src/state.js";
import { carryForwardFacts, factId, factStableProjection, selectSymbols } from "../src/local/facts.js";
import { fallbackOutline, validateOutline, type PageOutline } from "../src/local/outline.js";
import { resolveFactPlaceholders, sectionInputHash } from "../src/local/sections.js";
import { deepToFileSummary } from "../src/local/deep-summaries.js";
import type { PagePlan } from "../src/vendor/llm/passes-v2.js";

const sym = (name: string, start: number, end: number, sig = "fn()", exported = true): Symbol => ({
  name,
  kind: "function",
  signature: sig,
  startLine: start,
  endLine: end,
  exported,
});

const fact = (id: string, path: string, symbol: string, text: string, start = 10, end = 20): Fact => ({
  id,
  text,
  path,
  symbol,
  kind: "function",
  startLine: start,
  endLine: end,
});

const brief: PagePlan = {
  slug: "state",
  title: "State persistence",
  kind: "module",
  description: "How state is stored.",
  module_paths: ["src"],
  extra_paths: [],
  questions: ["How are writes kept atomic?", "What survives a crash?"],
};

test("factId is stable under line drift, sensitive to text", () => {
  const a = factId("src/a.ts", "save", "function", "Writes are atomic.");
  const b = factId("src/a.ts", "save", "function", "  writes   are ATOMIC. ");
  const c = factId("src/a.ts", "save", "function", "Writes are buffered.");
  assert.equal(a, b, "normalization makes whitespace/case irrelevant");
  assert.notEqual(a, c);
});

test("carryForwardFacts keeps moved symbols, drops changed ones", () => {
  const facts = [
    fact("aaaaaa", "src/a.ts", "foo", "Fact about foo.", 12, 18),
    fact("bbbbbb", "src/a.ts", "bar", "Fact about bar.", 30, 40),
  ];
  const oldSymbols = [sym("foo", 10, 20), sym("bar", 30, 40)];
  // foo moved +7 unchanged; bar changed body length
  const newSymbols = [sym("foo", 17, 27), sym("bar", 30, 45)];
  const { kept, staleSymbols } = carryForwardFacts(facts, "src/a.ts", oldSymbols, newSymbols);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].startLine, 19);
  assert.equal(kept[0].endLine, 25);
  assert.ok(staleSymbols.has("bar"));
});

test("selectSymbols prefers exported, respects cap", () => {
  const symbols = [
    sym("internal", 1, 50, "fn()", false),
    sym("small", 60, 62),
    sym("large", 70, 120),
  ];
  const picked = selectSymbols(symbols, 2);
  assert.deepEqual(
    picked.map((s) => s.name),
    ["large", "small"],
  );
});

test("validateOutline dedupes and reassigns strays", () => {
  const facts = [fact("aaaaaa", "src/a.ts", "foo", "A."), fact("bbbbbb", "src/b.ts", "bar", "B.")];
  const raw: PageOutline = {
    sections: [
      { heading: "How it works", scope: "", question_idx: [0, 0, 9], fact_ids: ["aaaaaa", "aaaaaa", "zzzzzz"], full_source_paths: ["src/a.ts", "nope.ts"] },
      { heading: "How it works", scope: "dup", question_idx: [], fact_ids: [], full_source_paths: [] },
      { heading: "Crash safety", scope: "", question_idx: [], fact_ids: [], full_source_paths: [] },
    ],
  };
  const outline = validateOutline(raw, facts, brief, [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  assert.ok(outline);
  assert.equal(outline!.sections.length, 2, "duplicate heading dropped");
  assert.deepEqual(outline!.sections[0].fact_ids, ["aaaaaa"]);
  assert.deepEqual(outline!.sections[0].full_source_paths, ["src/a.ts"]);
  const allFacts = outline!.sections.flatMap((s) => s.fact_ids);
  assert.ok(allFacts.includes("bbbbbb"), "stray fact reassigned");
  const allQuestions = outline!.sections.flatMap((s) => s.question_idx).sort();
  assert.deepEqual(allQuestions, [0, 1], "every question assigned exactly once");
});

test("fallbackOutline covers all facts and questions", () => {
  const facts = [fact("aaaaaa", "src/a.ts", "foo", "A."), fact("bbbbbb", "src/b.ts", "bar", "B.")];
  const outline = fallbackOutline(brief, facts, [{ path: "src/a.ts" }]);
  assert.ok(outline.sections.length >= 3);
  const allFacts = outline.sections.flatMap((s) => s.fact_ids).sort();
  assert.deepEqual(allFacts, ["aaaaaa", "bbbbbb"]);
  assert.equal(outline.sections.flatMap((s) => s.question_idx).length, brief.questions.length);
});

test("resolveFactPlaceholders substitutes current lines and strips unknowns", () => {
  const byId = new Map([["aaaaaa", fact("aaaaaa", "src/a.ts", "foo", "A.", 42, 58)]]);
  const { markdown, unknown } = resolveFactPlaceholders(
    "Atomic writes are used. [[f:aaaaaa]] Bogus claim. [[f:ffffff]]",
    byId,
  );
  assert.ok(markdown.includes("[[cite:src/a.ts:42-58]]"));
  assert.ok(!markdown.includes("f:ffffff"));
  assert.deepEqual(unknown, ["ffffff"]);
});

test("sectionInputHash ignores fact line numbers via stable projection", () => {
  const before = fact("aaaaaa", "src/a.ts", "foo", "A.", 10, 20);
  const after = { ...before, startLine: 50, endLine: 60 };
  const base = {
    model: "m",
    brief,
    heading: "H",
    scope: "",
    questions: [] as string[],
    sourceBlobShas: [] as string[],
    otherHeadings: [] as string[],
  };
  const h1 = sectionInputHash({ ...base, factProjections: [factStableProjection(before)] });
  const h2 = sectionInputHash({ ...base, factProjections: [factStableProjection(after)] });
  assert.equal(h1, h2, "line drift does not bust the section cache");
  const h3 = sectionInputHash({
    ...base,
    factProjections: [factStableProjection({ ...before, text: "Changed." , id: "cccccc"})],
  });
  assert.notEqual(h1, h3);
});

test("deepToFileSummary projects onto the vendored shape", () => {
  const projected = deepToFileSummary({
    purpose: "Stores state.",
    key_symbols: [{ name: "StateStore", role: "class" }],
    main_flows: ["load then save"],
    gotchas: ["state.json written last"],
    config_keys: [],
  });
  assert.equal(projected.purpose, "Stores state.");
  assert.deepEqual(projected.public_api, ["StateStore"]);
  assert.ok(projected.notes?.includes("state.json written last"));
});
