// Working-tree ingest: the local counterpart of the cloud tarball ingest
// (repofold-cloud packages/core/src/pipeline/ingest.ts). Same classification,
// hashing and limits; the file list comes from git instead of a GitHub
// tarball, and results go to the caller instead of a database.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  classifyFile,
  createIgnoreFilter,
  MAX_FILE_BYTES,
  type FileKind,
} from "./vendor/pipeline/filter.js";
import { detectLanguage } from "./vendor/pipeline/language.js";
import type { SourceStore } from "./vendor/pipeline/source-store.js";
import { listWorkingTreeFiles } from "./git.js";

export type IngestedFile = {
  path: string;
  kind: FileKind;
  language: string | null;
  blobSha: string;
  sizeBytes: number;
  lineCount: number | null;
  hasContent: boolean;
};

export type IngestResult = {
  files: IngestedFile[];
  stats: { total: number; analyzable: number; skipped: number; bytesStored: number };
};

const MAX_REPO_ENTRIES = 50_000;
const MAX_ANALYZABLE_BYTES = 250 * 1024 * 1024;

/** git blob SHA, identical to what `git hash-object` produces. */
export function gitBlobSha(buf: Buffer): string {
  return createHash("sha1")
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest("hex");
}

export async function ingestWorkingTree(opts: {
  repoPath: string;
  sourceStore: SourceStore;
  extraIgnoreGlobs?: string[];
  /** repo-relative directories to skip entirely (e.g. the wiki output dir) */
  excludeDirs?: string[];
  onProgress?: (filesSeen: number) => void;
}): Promise<IngestResult> {
  const { repoPath, sourceStore, extraIgnoreGlobs = [], excludeDirs = [], onProgress } = opts;
  const ig = createIgnoreFilter(extraIgnoreGlobs);
  // Never generate documentation about the tool's own artifacts, even when
  // the user has not gitignored them yet.
  const excluded = [".repofold", ...excludeDirs.map((d) => d.replace(/\\/g, "/").replace(/\/+$/, ""))]
    .filter((d) => d !== "" && d !== "." && !d.startsWith(".."));

  const paths = await listWorkingTreeFiles(repoPath);
  if (paths.length > MAX_REPO_ENTRIES) {
    throw new Error(`Repository exceeds ${MAX_REPO_ENTRIES} files`);
  }

  const ingested: IngestedFile[] = [];
  let bytesStored = 0;
  let seen = 0;

  for (const relPath of paths) {
    if (excluded.some((d) => relPath === d || relPath.startsWith(`${d}/`))) continue;

    seen++;
    if (seen % 500 === 0) onProgress?.(seen);

    const absolute = path.join(repoPath, relPath);
    let sizeBytes: number;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      sizeBytes = info.size;
    } catch {
      continue; // deleted since ls-files (race) or unreadable: skip
    }

    if (sizeBytes > MAX_FILE_BYTES) {
      ingested.push({
        path: relPath,
        kind: "ignored",
        language: null,
        blobSha: "",
        sizeBytes,
        lineCount: null,
        hasContent: false,
      });
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(absolute);
    } catch {
      continue;
    }

    const { kind, content } = await classifyFile({
      path: relPath,
      sizeBytes: buf.length,
      ig,
      getContent: () => buf,
    });

    const blobSha = gitBlobSha(buf);
    const language =
      kind === "source" || kind === "config" || kind === "doc"
        ? detectLanguage(relPath, content)
        : null;

    const keepContent = content !== undefined;
    if (keepContent) {
      if (bytesStored + buf.length > MAX_ANALYZABLE_BYTES) {
        throw new Error("Repository exceeds 250 MB of analyzable text");
      }
      await sourceStore.put(blobSha, content);
      bytesStored += buf.length;
    }

    ingested.push({
      path: relPath,
      kind,
      language,
      blobSha,
      sizeBytes: buf.length,
      lineCount: keepContent ? content.split("\n").length : null,
      hasContent: keepContent,
    });
  }

  const analyzable = ingested.filter((f) => ["source", "config", "doc"].includes(f.kind)).length;

  return {
    files: ingested,
    stats: {
      total: ingested.length,
      analyzable,
      skipped: ingested.length - analyzable,
      bytesStored,
    },
  };
}
