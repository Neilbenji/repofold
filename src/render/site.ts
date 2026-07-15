// Static site generator: turns the .repofold page state into a browsable
// HTML wiki. All links are relative and end in .html, so the output works
// identically from file:// and behind "repofold serve".
import { cp, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WikiMarkdown } from "./markdown.js";
import { WikiPage, type PagerLink } from "./layout.js";
import { buildWikiTree, flattenPages, type WikiPageRow } from "./wiki-tree.js";
import { extractHeadings } from "./extract-headings.js";
import { renderCitations, type CitationTarget } from "./citations.js";
import type { ChangelogEntry, PageRecord } from "../state.js";

export type SiteInput = {
  outDir: string;
  repo: { owner: string; name: string };
  githubUrl: string | null;
  citationTarget: CitationTarget;
  commitSha: string;
  pages: PageRecord[];
  markdownOf: (slug: string) => Promise<string | null>;
  changelog: ChangelogEntry[];
};

/** Package root (assets/ lives beside dist/ and src/). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Output file for a slug: the first page is index.html, the rest <slug>.html. */
function outputFile(slug: string, isRoot: boolean): string {
  return isRoot ? "index.html" : `${slug}.html`;
}

/** Relative href from the directory of one output file to another file. */
function relativeHref(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile);
  const rel = path.posix.relative(fromDir, toFile);
  return rel === "" ? "." : rel;
}

export async function generateSite(input: SiteInput): Promise<void> {
  const published = input.pages
    .filter((p) => p.kind === "section" || (p.status === "published"))
    .sort((a, b) => a.position - b.position);

  // buildWikiTree wants numeric ids/parentIds; synthesize them from slugs
  const idBySlug = new Map(published.map((p, i) => [p.slug, i + 1]));
  const rows: WikiPageRow[] = published.map((p) => ({
    id: idBySlug.get(p.slug)!,
    slug: p.slug,
    title: p.title,
    kind: p.kind,
    parentId: p.parentSlug != null ? (idBySlug.get(p.parentSlug) ?? null) : null,
    position: p.position,
  }));
  const tree = buildWikiTree(rows);
  const ordered = flattenPages(tree);
  if (ordered.length === 0) throw new Error("No published pages to render.");

  const rootSlug = ordered[0].slug;
  const fileOf = new Map(ordered.map((p) => [p.slug, outputFile(p.slug, p.slug === rootSlug)]));
  const hasChangelog = input.changelog.length > 0;

  await mkdir(input.outDir, { recursive: true });

  let anyMermaid = false;
  const renderedPages: Array<{ file: string; html: string; usesMermaid: boolean }> = [];

  for (const [index, page] of ordered.entries()) {
    const record = input.pages.find((p) => p.slug === page.slug);
    const rawMarkdown = (await input.markdownOf(page.slug)) ?? "";
    const markdown = renderCitations(rawMarkdown, input.citationTarget);
    const file = fileOf.get(page.slug)!;
    const usesMermaid = markdown.includes("```mermaid");
    anyMermaid ||= usesMermaid;

    const hrefFor = (slug: string) => relativeHref(file, fileOf.get(slug) ?? `${slug}.html`);
    const assetHref = (asset: string) => relativeHref(file, `assets/${asset}`);
    const content = await WikiMarkdown({ markdown, resolveInternalHref: hrefFor });

    const prevPage = index > 0 ? ordered[index - 1] : null;
    const nextPage = index < ordered.length - 1 ? ordered[index + 1] : null;
    const prev: PagerLink = prevPage ? { title: prevPage.title, href: hrefFor(prevPage.slug) } : null;
    const next: PagerLink = nextPage ? { title: nextPage.title, href: hrefFor(nextPage.slug) } : null;

    const html = renderToStaticMarkup(
      createElement(WikiPage, {
        repo: input.repo,
        githubUrl: input.githubUrl,
        tree,
        activeSlug: page.slug,
        hrefFor,
        assetHref,
        changelogHref: hasChangelog ? relativeHref(file, "changelog.html") : null,
        toc: extractHeadings(rawMarkdown),
        prev,
        next,
        commitSha: record?.commitSha ?? input.commitSha,
        includeMermaid: usesMermaid,
        children: content,
      }),
    );
    renderedPages.push({ file, html: `<!doctype html>\n${html}`, usesMermaid });
  }

  // Changelog page from the recorded entries, newest first
  if (hasChangelog) {
    const file = "changelog.html";
    const hrefFor = (slug: string) => relativeHref(file, fileOf.get(slug) ?? `${slug}.html`);
    const assetHref = (asset: string) => relativeHref(file, `assets/${asset}`);
    const entriesMarkdown = [...input.changelog]
      .reverse()
      .map((entry) => {
        const date = entry.createdAt.slice(0, 10);
        const range =
          entry.fromCommitSha === entry.toCommitSha
            ? entry.toCommitSha.slice(0, 7)
            : `${entry.fromCommitSha.slice(0, 7)} to ${entry.toCommitSha.slice(0, 7)}`;
        return `## ${date}\n\n${entry.summary}\n\n*Commits: ${range}*`;
      })
      .join("\n\n");
    const markdown = `# Changelog\n\nWhat changed in this wiki as the code evolved.\n\n${entriesMarkdown}`;
    const content = await WikiMarkdown({
      markdown,
      resolveInternalHref: (slug) => hrefFor(slug.replace(/^wiki\//, "")),
    });
    const html = renderToStaticMarkup(
      createElement(WikiPage, {
        repo: input.repo,
        githubUrl: input.githubUrl,
        tree,
        activeSlug: "",
        hrefFor,
        assetHref,
        changelogHref: ".",
        toc: [],
        prev: null,
        next: null,
        commitSha: input.commitSha,
        includeMermaid: false,
        children: content,
      }),
    );
    renderedPages.push({ file, html: `<!doctype html>\n${html}`, usesMermaid: false });
  }

  for (const page of renderedPages) {
    const target = path.join(input.outDir, page.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, page.html, "utf8");
  }

  // Assets: css, behavior script, favicon; mermaid only when actually used
  const root = packageRoot();
  const assetsOut = path.join(input.outDir, "assets");
  await mkdir(path.join(assetsOut, "js"), { recursive: true });
  await cp(path.join(root, "assets", "css"), path.join(assetsOut, "css"), { recursive: true });
  await cp(path.join(root, "assets", "js", "repofold.js"), path.join(assetsOut, "js", "repofold.js"));
  await cp(path.join(root, "assets", "favicon.svg"), path.join(assetsOut, "favicon.svg"));
  if (anyMermaid) {
    const bundled = path.join(root, "assets", "js", "mermaid.min.js");
    try {
      await access(bundled);
      await cp(bundled, path.join(assetsOut, "js", "mermaid.min.js"));
    } catch {
      // packaged builds always ship the bundle; a source checkout needs `pnpm build` once
    }
  }
}
