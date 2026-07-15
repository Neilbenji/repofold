import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    return (await git(repoPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

export async function headSha(repoPath: string): Promise<string> {
  return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
}

export async function isDirty(repoPath: string): Promise<boolean> {
  return (await git(repoPath, ["status", "--porcelain"])).trim().length > 0;
}

/** Tracked + untracked files, .gitignore respected. Paths are /-separated. */
export async function listWorkingTreeFiles(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(out.split("\0").filter(Boolean))];
}

/** owner/name from the origin remote when it points at GitHub, else null. */
export async function githubRemote(
  repoPath: string,
): Promise<{ owner: string; name: string } | null> {
  try {
    const url = (await git(repoPath, ["remote", "get-url", "origin"])).trim();
    const match =
      /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!match) return null;
    return { owner: match[1], name: match[2] };
  } catch {
    return null;
  }
}
