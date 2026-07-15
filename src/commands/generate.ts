import path from "node:path";
import { stat } from "node:fs/promises";
import { stateDir, type RepofoldConfig } from "../config.js";
import { preflight } from "../preflight.js";
import { githubRemote, isGitRepo } from "../git.js";
import { runPipeline } from "../orchestrator.js";
import { Progress } from "../progress.js";
import { StateStore } from "../state.js";
import { generateSite } from "../render/site.js";
import { exportMarkdown } from "../export-markdown.js";
import type { CitationTarget } from "../render/citations.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function runGenerate(
  config: RepofoldConfig,
  opts: { servePort?: number },
): Promise<void> {
  if (!(await isGitRepo(config.repoPath))) {
    throw new Error(
      `${config.repoPath} is not a git repository. repofold anchors citations and the changelog to commits, so it needs one; run "git init" and commit first.`,
    );
  }

  const remote = await githubRemote(config.repoPath);
  const repoLabel = remote ?? {
    owner: path.basename(path.dirname(config.repoPath)) || "local",
    name: path.basename(config.repoPath),
  };

  await preflight(config);

  const progress = new Progress();
  console.log(
    `repofold: generating a wiki for ${repoLabel.owner}/${repoLabel.name} with ${config.model} (${config.ollamaUrl})`,
  );

  const result = await runPipeline(config, repoLabel, progress);

  // one-time hint: keep the tool's artifacts out of the user's history
  if (!(await exists(path.join(config.repoPath, ".repofold", ".hint-shown")))) {
    const outName = path.relative(config.repoPath, config.outDir) || "repofold-wiki";
    if (!outName.startsWith("..")) {
      console.log(`Tip: add ".repofold/" and "${outName.replace(/\\/g, "/")}/" to your .gitignore.`);
    } else {
      console.log('Tip: add ".repofold/" to your .gitignore.');
    }
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(stateDir(config), { recursive: true });
    await writeFile(path.join(stateDir(config), ".hint-shown"), "", "utf8");
  }

  // Render outputs (also when the pipeline was a no-op, so --out moves work)
  const store = new StateStore(stateDir(config));
  const pages = await store.loadPages();
  const changelog = await store.loadChangelog();
  const citationTarget: CitationTarget = remote
    ? { kind: "github", owner: remote.owner, name: remote.name, sha: result.commitSha }
    : config.repoUrl
      ? { kind: "url", base: config.repoUrl, sha: result.commitSha }
      : { kind: "none" };

  if (config.html) {
    await generateSite({
      outDir: config.outDir,
      repo: repoLabel,
      githubUrl: remote ? `https://github.com/${remote.owner}/${remote.name}` : null,
      citationTarget,
      commitSha: result.commitSha,
      pages,
      markdownOf: (slug) => store.loadPageMarkdown(slug),
      changelog,
    });
  }
  if (config.markdown) {
    await exportMarkdown({
      outDir: config.outDir,
      repo: repoLabel,
      commitSha: result.commitSha,
      pages,
      markdownOf: (slug) => store.loadPageMarkdown(slug),
    });
  }

  progress.summary(result.counts, config.outDir);

  if (opts.servePort) {
    const { startServer } = await import("../serve.js");
    await startServer(config.outDir, opts.servePort);
  }
}
