import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serve a generated wiki directory on localhost. Never binds to other interfaces. */
export async function startServer(rootDir: string, port: number): Promise<void> {
  try {
    await stat(path.join(rootDir, "index.html"));
  } catch {
    throw new Error(`No wiki found at ${rootDir}. Run "repofold generate" first.`);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.join(rootDir, path.normalize(pathname));
      if (!file.startsWith(path.resolve(rootDir))) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      let target = file;
      try {
        const info = await stat(target);
        if (info.isDirectory()) target = path.join(target, "index.html");
      } catch {
        if (!path.extname(target)) target = `${target}.html`;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Serving wiki at http://localhost:${port} (Ctrl+C to stop)`);
}
