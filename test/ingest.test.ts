import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitBlobSha, ingestWorkingTree } from "../src/ingest.js";
import { treeFingerprint, StateStore, emptyState } from "../src/state.js";
import { EncryptedTempSourceStore } from "../src/vendor/pipeline/source-store.js";

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "repofold-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  await writeFile(path.join(dir, "index.ts"), 'export const answer = 42;\nexport function add(a: number, b: number) {\n  return a + b;\n}\n');
  await writeFile(path.join(dir, "README.md"), "# Fixture\n\nA tiny repo for tests.\n");
  await writeFile(path.join(dir, "package.json"), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  await mkdir(path.join(dir, "node_modules", "junk"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "junk", "ignored.js"), "ignored");
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

test("gitBlobSha matches git hash-object", async () => {
  const dir = await makeFixtureRepo();
  try {
    const content = Buffer.from('export const answer = 42;\nexport function add(a: number, b: number) {\n  return a + b;\n}\n');
    const expected = execFileSync("git", ["-C", dir, "hash-object", "index.ts"]).toString().trim();
    assert.equal(gitBlobSha(content), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ingestWorkingTree classifies files and respects ignores", async () => {
  const dir = await makeFixtureRepo();
  const store = await EncryptedTempSourceStore.create();
  try {
    const result = await ingestWorkingTree({ repoPath: dir, sourceStore: store });
    const byPath = new Map(result.files.map((f) => [f.path, f]));

    assert.ok(byPath.has("index.ts"), "source file ingested");
    assert.equal(byPath.get("index.ts")!.kind, "source");
    assert.equal(byPath.get("index.ts")!.language, "typescript");
    assert.equal(byPath.get("README.md")!.kind, "doc");
    assert.equal(byPath.get("package.json")!.kind, "config");
    assert.ok(!byPath.has("node_modules/junk/ignored.js"), "gitignored files excluded");

    const stored = await store.get(byPath.get("index.ts")!.blobSha);
    assert.ok(stored?.includes("answer = 42"), "source retrievable from store");
  } finally {
    await store.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("treeFingerprint is order-independent and content-sensitive", () => {
  const a = treeFingerprint([
    { path: "a.ts", blobSha: "1".repeat(40) },
    { path: "b.ts", blobSha: "2".repeat(40) },
  ]);
  const b = treeFingerprint([
    { path: "b.ts", blobSha: "2".repeat(40) },
    { path: "a.ts", blobSha: "1".repeat(40) },
  ]);
  const c = treeFingerprint([
    { path: "a.ts", blobSha: "3".repeat(40) },
    { path: "b.ts", blobSha: "2".repeat(40) },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("StateStore round-trips and writes atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repofold-state-"));
  try {
    const store = new StateStore(dir);
    const state = { ...emptyState(), lastIndexedCommitSha: "abc", planVersion: 2 };
    await store.saveState(state);
    assert.deepEqual(await store.load(), state);

    await store.savePageMarkdown("architecture/overview", "# Hello\n");
    assert.equal(await store.loadPageMarkdown("architecture/overview"), "# Hello\n");

    const sha = "a".repeat(40);
    await store.saveAnalysis(sha, {
      symbols: [],
      imports: [],
      summary: null,
      summaryVersion: null,
      summaryModel: null,
    });
    assert.ok(await store.loadAnalysis(sha));
    await store.pruneAnalysis(new Set());
    assert.equal(await store.loadAnalysis(sha), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
