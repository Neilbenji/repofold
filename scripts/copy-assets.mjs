// Copies the mermaid browser bundle out of node_modules so the generated
// sites can ship it as a local asset (no CDN, no external requests).
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const source = require.resolve("mermaid/dist/mermaid.min.js");
const target = path.join(root, "..", "assets", "js", "mermaid.min.js");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`Copied mermaid bundle to ${path.relative(process.cwd(), target)}`);
