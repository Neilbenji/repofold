// Sanity checks for the deterministic patch/drift helpers, ported from
// repofold-cloud apps/worker/src/helpers-test.ts (imports + test runner only).
import { test } from "node:test";
import assert from "node:assert";
import {
  splitMarkdownSections,
  assemblePatchedPage,
  normalizePageText,
} from "../src/vendor/llm/passes-v2.js";
import { remapCitationDrift } from "../src/vendor/pipeline/citation-drift.js";
import type { Symbol } from "../src/vendor/pipeline/treesitter.js";

const page = `# Title

Intro line.

## Purpose

Body A [[cite:src/a.ts:10-20]].

## How it works

\`\`\`ts
## not a heading, inside fence
\`\`\`

Body B.

## Related pages

- [Other](/wiki/other)
`;

test("splitMarkdownSections", () => {
  const split = splitMarkdownSections(page);
  assert.equal(split.sections.length, 3, "three sections");
  assert.equal(split.sections[0].heading, "Purpose");
  assert.equal(split.sections[1].heading, "How it works");
  assert.ok(split.sections[1].block.includes("## not a heading, inside fence"), "fence content kept");
  assert.ok(split.preamble.startsWith("# Title"), "preamble has H1");
});

test("assemblePatchedPage replace/reorder/restore", () => {
  const patched = assemblePatchedPage(page, {
    sections: ["Purpose", "How it works", "Related pages"],
    content: { "How it works": "## How it works\n\nNew body B." },
  });
  assert.ok(patched, "patch applies");
  assert.ok(patched!.includes("Body A [[cite:src/a.ts:10-20]]"), "kept section byte-identical");
  assert.ok(patched!.includes("New body B."), "replaced section present");
  assert.ok(!patched!.includes("Body B."), "old body gone");
  assert.ok(patched!.startsWith("# Title"), "preamble kept");

  const reordered = assemblePatchedPage(page, {
    sections: ["How it works", "Purpose", "Related pages"],
    content: {},
  });
  assert.ok(reordered!.indexOf("How it works") < reordered!.indexOf("Purpose"), "reorder works");

  const omitted = assemblePatchedPage(page, {
    sections: ["Purpose", "How it works"],
    content: { "How it works": "## How it works\n\nNew body B." },
  });
  assert.ok(omitted!.includes("## Related pages"), "omitted section restored");
  assert.ok(
    omitted!.indexOf("How it works") < omitted!.indexOf("Related pages"),
    "restored section keeps its position",
  );

  const omittedFirst = assemblePatchedPage(page, {
    sections: ["How it works", "Related pages"],
    content: {},
  });
  assert.ok(
    omittedFirst!.indexOf("## Purpose") < omittedFirst!.indexOf("## How it works"),
    "leading omission restored first",
  );

  assert.equal(
    assemblePatchedPage(page, {
      sections: ["Purpose", "How it works", "Fresh section"],
      content: { "Fresh section": "## Fresh section\n\nNew." },
    }),
    null,
    "omission + new heading bails out",
  );

  const added = assemblePatchedPage(page, {
    sections: ["Purpose", "How it works", "Related pages", "Fresh section"],
    content: { "Fresh section": "## Fresh section\n\nNew." },
  });
  assert.ok(added!.includes("## Fresh section"), "new section added");
  assert.ok(added!.includes("## Related pages"), "existing sections kept");

  assert.equal(assemblePatchedPage(page, { sections: ["Nope"], content: {} }), null);
  assert.equal(
    assemblePatchedPage(page, {
      sections: ["Purpose", "Purpose", "How it works", "Related pages"],
      content: {},
    }),
    null,
  );

  const prefixed = assemblePatchedPage(page, {
    sections: ["Purpose", "How it works", "Related pages"],
    content: { Purpose: "Plain text." },
  });
  assert.ok(prefixed!.includes("## Purpose\n\nPlain text."), "heading prefixed");
});

test("normalizePageText", () => {
  assert.equal(
    normalizePageText("# T \n\n\n\nBody line.  \n"),
    normalizePageText("# T\n\nBody line."),
    "whitespace and blank-line jitter is equal",
  );
  assert.notEqual(
    normalizePageText("Body `}));`"),
    normalizePageText("Body `}),\n);`"),
    "real text differences stay different",
  );
});

test("remapCitationDrift", () => {
  const sym = (name: string, start: number, end: number, sig = "fn()"): Symbol => ({
    name,
    kind: "function",
    signature: sig,
    startLine: start,
    endLine: end,
    exported: true,
  });
  const md = "See [[cite:src/a.ts:12-18]] and [[cite:src/b.ts:5-9]] and [[cite:src/a.ts]].";

  const ok = remapCitationDrift({
    markdown: md,
    changedPaths: new Set(["src/a.ts"]),
    oldSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 20)]]]),
    newSymbolsByPath: new Map([["src/a.ts", [sym("foo", 17, 27)]]]),
  });
  assert.ok(ok.ok, "drift remap succeeds");
  if (ok.ok) {
    assert.ok(ok.markdown.includes("[[cite:src/a.ts:19-25]]"), "range shifted by +7");
    assert.ok(ok.markdown.includes("[[cite:src/b.ts:5-9]]"), "unchanged file untouched");
    assert.ok(ok.markdown.includes("[[cite:src/a.ts]]."), "path-only cite untouched");
    assert.equal(ok.remapped, 1);
  }

  const lenChanged = remapCitationDrift({
    markdown: md,
    changedPaths: new Set(["src/a.ts"]),
    oldSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 20)]]]),
    newSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 23)]]]),
  });
  assert.equal(lenChanged.ok, false, "length change refused");

  const sigChanged = remapCitationDrift({
    markdown: md,
    changedPaths: new Set(["src/a.ts"]),
    oldSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 20)]]]),
    newSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 20, "fn(x)")]]]),
  });
  assert.equal(sigChanged.ok, false, "signature change refused");

  const inconsistent = remapCitationDrift({
    markdown: "X [[cite:src/a.ts:10-40]]",
    changedPaths: new Set(["src/a.ts"]),
    oldSymbolsByPath: new Map([["src/a.ts", [sym("foo", 10, 20), sym("bar", 30, 40)]]]),
    newSymbolsByPath: new Map([["src/a.ts", [sym("foo", 12, 22), sym("bar", 35, 45)]]]),
  });
  assert.equal(inconsistent.ok, false, "inconsistent offsets refused");

  const untouched = remapCitationDrift({
    markdown: md,
    changedPaths: new Set(),
    oldSymbolsByPath: new Map(),
    newSymbolsByPath: new Map(),
  });
  assert.ok(untouched.ok && untouched.remapped === 0 && untouched.markdown === md, "no-op stays identical");
});
