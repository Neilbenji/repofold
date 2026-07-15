/**
 * Deterministic project facts from manifests, docker-compose, CI and env
 * templates — zero tokens. Feeds the wiki planner and the overview /
 * getting-started pages.
 */

export type ManifestInput = {
  path: string;
  content: string;
};

export type ManifestFacts = {
  text: string; // rendered block for prompts
  workspaceNameToDir: Map<string, string>;
  anchorDirs: string[];
};

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function buildManifestFacts(inputs: ManifestInput[]): ManifestFacts {
  const facts: string[] = [];
  const workspaceNameToDir = new Map<string, string>();
  const anchorDirs: string[] = [];

  const byBase = (base: string) =>
    inputs.filter((i) => (i.path.split("/").pop() ?? "").toLowerCase() === base);

  // --- package.json (all of them) ---
  const pkgs = byBase("package.json");
  for (const pkg of pkgs) {
    try {
      const json = JSON.parse(pkg.content);
      const dir = dirname(pkg.path);
      if (dir !== "") anchorDirs.push(dir);
      if (json.name) workspaceNameToDir.set(json.name, dir);
      const loc = dir === "" ? "root" : dir;
      const bits: string[] = [];
      if (json.name) bits.push(`name ${json.name}`);
      if (json.scripts && Object.keys(json.scripts).length) {
        bits.push(`scripts: ${Object.keys(json.scripts).slice(0, 15).join(", ")}`);
      }
      const deps = Object.keys(json.dependencies ?? {});
      if (deps.length) bits.push(`deps: ${deps.slice(0, 20).join(", ")}`);
      if (json.engines?.node) bits.push(`node ${json.engines.node}`);
      if (bits.length) facts.push(`package.json (${loc}): ${bits.join(" | ")}`);
    } catch {
      // malformed manifest: skip
    }
  }

  // --- package manager / workspace layout ---
  const hasFile = (base: string) => inputs.some((i) => i.path.toLowerCase() === base);
  if (hasFile("pnpm-workspace.yaml")) facts.push("package manager: pnpm (workspace monorepo)");
  else if (hasFile("yarn.lock")) facts.push("package manager: yarn");
  else if (pkgs.length > 0) facts.push("package manager: npm (or compatible)");

  // --- python / go / rust manifests (regex-level extraction) ---
  for (const py of byBase("pyproject.toml")) {
    const dir = dirname(py.path);
    if (dir !== "") anchorDirs.push(dir);
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(py.content)?.[1];
    facts.push(`pyproject.toml (${dir || "root"})${name ? `: name ${name}` : ""}`);
  }
  for (const gomod of byBase("go.mod")) {
    const dir = dirname(gomod.path);
    if (dir !== "") anchorDirs.push(dir);
    const mod = /^module\s+(\S+)/m.exec(gomod.content)?.[1];
    facts.push(`go.mod (${dir || "root"})${mod ? `: module ${mod}` : ""}`);
  }
  for (const cargo of byBase("cargo.toml")) {
    const dir = dirname(cargo.path);
    if (dir !== "") anchorDirs.push(dir);
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo.content)?.[1];
    facts.push(`Cargo.toml (${dir || "root"})${name ? `: crate ${name}` : ""}`);
  }

  // --- docker-compose services (naive YAML scan) ---
  const composeFiles = inputs.filter((i) =>
    /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(i.path),
  );
  for (const compose of composeFiles) {
    const services: string[] = [];
    const lines = compose.content.split("\n");
    let inServices = false;
    let current: { name: string; image?: string; ports: string[] } | null = null;
    for (const line of lines) {
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices && /^\S/.test(line)) inServices = false; // left the services block
      if (!inServices) continue;
      const svc = /^  ([\w-]+):\s*$/.exec(line);
      if (svc) {
        if (current) {
          services.push(
            `${current.name}${current.image ? ` (${current.image}` : ""}${current.ports.length ? `${current.image ? ", " : " ("}ports ${current.ports.join(",")})` : current.image ? ")" : ""}`,
          );
        }
        current = { name: svc[1], ports: [] };
        continue;
      }
      if (current) {
        const img = /^\s+image:\s*(\S+)/.exec(line);
        if (img) current.image = img[1];
        const port = /^\s+-\s*"?(\d+):\d+"?/.exec(line);
        if (port) current.ports.push(port[1]);
      }
    }
    if (current) {
      services.push(
        `${current.name}${current.image ? ` (${current.image}${current.ports.length ? `, ports ${current.ports.join(",")}` : ""})` : current.ports.length ? ` (ports ${current.ports.join(",")})` : ""}`,
      );
    }
    if (services.length) facts.push(`docker services (${compose.path}): ${services.join("; ")}`);
  }
  const dockerfiles = inputs.filter((i) => /(^|\/)dockerfile/i.test(i.path));
  if (dockerfiles.length) {
    facts.push(`dockerfiles: ${dockerfiles.map((d) => d.path).slice(0, 8).join(", ")}`);
  }

  // --- CI workflows ---
  const workflows = inputs.filter((i) => /^\.github\/workflows\/.+\.ya?ml$/.test(i.path));
  for (const wf of workflows.slice(0, 10)) {
    const name = /^name:\s*(.+)$/m.exec(wf.content)?.[1]?.trim();
    const on = /^on:\s*(?:\[([^\]]+)\]|(\w+))/m.exec(wf.content);
    const trigger = on?.[1] ?? on?.[2] ?? "";
    facts.push(`CI workflow ${wf.path}${name ? ` ("${name}")` : ""}${trigger ? ` on ${trigger}` : ""}`);
  }

  // --- env template keys (names only, never values) ---
  const envFiles = inputs.filter((i) => /(^|\/)\.env\.(example|sample|template)$/i.test(i.path));
  for (const envFile of envFiles) {
    const keys = envFile.content
      .split("\n")
      .map((l) => /^([A-Z][A-Z0-9_]*)\s*=/.exec(l.trim())?.[1])
      .filter((k): k is string => !!k);
    if (keys.length) facts.push(`env vars (${envFile.path}): ${keys.join(", ")}`);
  }

  return {
    text: facts.join("\n"),
    workspaceNameToDir,
    anchorDirs: [...new Set(anchorDirs)],
  };
}
