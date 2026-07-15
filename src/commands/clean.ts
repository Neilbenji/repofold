import { rm, stat } from "node:fs/promises";
import readline from "node:readline/promises";
import { stateDir, type RepofoldConfig } from "../config.js";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function runClean(config: RepofoldConfig, opts: { yes: boolean }): Promise<void> {
  const targets = [stateDir(config), config.outDir];
  const present: string[] = [];
  for (const target of targets) if (await exists(target)) present.push(target);
  if (present.length === 0) {
    console.log("Nothing to clean.");
    return;
  }
  console.log("This will remove:");
  for (const target of present) console.log(`  ${target}`);
  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  for (const target of present) {
    await rm(target, { recursive: true, force: true });
    console.log(`Removed ${target}`);
  }
}
