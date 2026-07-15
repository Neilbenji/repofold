/**
 * Deterministic module derivation: turns the file list + import graph into
 * semantic modules with dependency edges and PageRank. Zero LLM tokens.
 */

export type ModuleFacts = {
  fileCount: number;
  externalDeps: string[];
  entryPointCandidates: string[];
  memberPaths: string[];
  rankSum: number;
};

export type ModuleDef = {
  path: string; // dir path, "" = root module; unique key
  name: string;
  filePaths: string[];
  facts: ModuleFacts;
};

export type ModuleGraph = {
  modules: ModuleDef[];
  edges: Array<{ from: string; to: string; weight: number }>;
  fileRank: Map<string, number>;
  moduleOf: Map<string, string>;
};

const ANCHOR_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "cargo.toml",
]);

const ENTRY_BASENAMES = /^(index|main|app|cli|server|worker)\.(ts|tsx|js|jsx|mjs|py|go|rs)$/i;

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function joinPath(base: string, rel: string): string {
  const parts = base === "" ? [] : base.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const JS_CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

export function resolveImport(
  fromPath: string,
  spec: string,
  filePathSet: Set<string>,
  workspaceNameToDir: Map<string, string>,
  language: string | null,
): { file?: string; external?: string } {
  if (language === "python") {
    // relative: leading dots resolve against the importing file's package
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)?.[0].length ?? 1;
      let base = dirname(fromPath);
      for (let i = 1; i < dots; i++) base = dirname(base);
      const rest = spec.slice(dots).replace(/\./g, "/");
      const candidate = rest ? joinPath(base, rest) : base;
      for (const c of [`${candidate}.py`, `${candidate}/__init__.py`]) {
        if (filePathSet.has(c)) return { file: c };
      }
      return {};
    }
    const dotted = spec.replace(/\./g, "/");
    for (const c of [`${dotted}.py`, `${dotted}/__init__.py`]) {
      if (filePathSet.has(c)) return { file: c };
    }
    // try relative to the importing file's top package roots
    let base = dirname(fromPath);
    while (true) {
      for (const c of [`${base}/${dotted}.py`, `${base}/${dotted}/__init__.py`]) {
        if (filePathSet.has(c)) return { file: c };
      }
      if (base === "") break;
      base = dirname(base);
    }
    return { external: spec.split(".")[0] };
  }

  // JS/TS family
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = joinPath(dirname(fromPath), spec);
    for (const suffix of JS_CANDIDATE_SUFFIXES) {
      if (filePathSet.has(base + suffix)) return { file: base + suffix };
    }
    return {};
  }
  if (spec.startsWith("@/")) {
    // common alias: try src/ and repo root
    const rest = spec.slice(2);
    for (const prefix of ["src/", "", "app/", "lib/"]) {
      for (const suffix of JS_CANDIDATE_SUFFIXES) {
        if (filePathSet.has(prefix + rest + suffix)) return { file: prefix + rest + suffix };
      }
    }
    return {};
  }
  // workspace package name (exact or subpath)
  const pkgName = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  const wsDir = workspaceNameToDir.get(pkgName);
  if (wsDir !== undefined) {
    const subpath = spec.slice(pkgName.length).replace(/^\//, "");
    const bases = subpath
      ? [joinPath(wsDir, subpath), joinPath(wsDir, `src/${subpath}`)]
      : [joinPath(wsDir, "src/index"), joinPath(wsDir, "index"), joinPath(wsDir, "src/main")];
    for (const base of bases) {
      for (const suffix of JS_CANDIDATE_SUFFIXES) {
        if (filePathSet.has(base + suffix)) return { file: base + suffix };
      }
    }
    return { file: undefined, external: undefined }; // internal but unresolved: ignore
  }
  return { external: pkgName };
}

// ---------------------------------------------------------------------------
// PageRank (power iteration)
// ---------------------------------------------------------------------------

export function pageRank(
  nodes: string[],
  edges: Array<[string, string]>, // importer -> imported (imported gains rank)
  d = 0.85,
  iters = 25,
): Map<string, number> {
  const n = nodes.length;
  if (n === 0) return new Map();
  const idx = new Map(nodes.map((node, i) => [node, i]));
  const out: number[][] = Array.from({ length: n }, () => []);
  const outdeg = new Array(n).fill(0);
  for (const [from, to] of edges) {
    const f = idx.get(from);
    const t = idx.get(to);
    if (f === undefined || t === undefined || f === t) continue;
    out[f].push(t);
    outdeg[f]++;
  }
  let rank = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill((1 - d) / n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outdeg[i] === 0) {
        danglingMass += rank[i];
        continue;
      }
      const share = (d * rank[i]) / outdeg[i];
      for (const t of out[i]) next[t] += share;
    }
    const danglingShare = (d * danglingMass) / n;
    for (let i = 0; i < n; i++) next[i] += danglingShare;
    rank = next;
  }
  return new Map(nodes.map((node, i) => [node, rank[i]]));
}

// ---------------------------------------------------------------------------
// Module derivation
// ---------------------------------------------------------------------------

export function deriveModules(input: {
  files: Array<{ path: string; language: string | null }>;
  importsByPath: Map<string, string[]>;
  /** package-name -> dir for workspace packages (from parsed package.json files) */
  workspaceNameToDir?: Map<string, string>;
  /** dirs containing a workspace manifest (hard module boundaries) */
  anchorDirs?: string[];
  minFiles?: number;
  maxModules?: number;
}): ModuleGraph {
  const {
    files,
    importsByPath,
    workspaceNameToDir = new Map(),
    minFiles = 3,
    maxModules = 60,
  } = input;
  const anchorDirs = new Set(input.anchorDirs ?? []);
  const filePathSet = new Set(files.map((f) => f.path));
  const langOf = new Map(files.map((f) => [f.path, f.language]));

  // --- subtree counts ---
  const subtreeCount = new Map<string, number>();
  for (const f of files) {
    let dir = dirname(f.path);
    while (true) {
      subtreeCount.set(dir, (subtreeCount.get(dir) ?? 0) + 1);
      if (dir === "") break;
      dir = dirname(dir);
    }
  }

  // --- pick module dirs with adaptive threshold ---
  const pickModules = (splitMin: number, minF: number): Set<string> => {
    const moduleDirs = new Set<string>([""]);
    const dirs = [...subtreeCount.keys()].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const dir of dirs) {
      if (dir === "") continue;
      const count = subtreeCount.get(dir)!;
      const isAnchor = anchorDirs.has(dir);
      if (isAnchor && count >= 1) {
        moduleDirs.add(dir);
        continue;
      }
      if (count >= splitMin) {
        // only split if the parent module keeps enough files of its own OR
        // the dir is a meaningful standalone unit
        if (count >= minF) moduleDirs.add(dir);
      }
    }
    return moduleDirs;
  };

  let splitMin = 5;
  let minF = minFiles;
  let moduleDirs = pickModules(splitMin, minF);
  const assign = (dirs: Set<string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const f of files) {
      let dir = dirname(f.path);
      while (!dirs.has(dir)) dir = dirname(dir);
      m.set(f.path, dir);
    }
    return m;
  };
  let moduleOf = assign(moduleDirs);
  const countModules = () => new Set(moduleOf.values()).size;

  // adaptive: too many -> coarser; too few -> finer
  for (const next of [8, 12, 20, 35]) {
    if (countModules() <= maxModules) break;
    splitMin = next;
    moduleDirs = pickModules(splitMin, next);
    moduleOf = assign(moduleDirs);
  }
  if (countModules() < 8 && files.length > 25) {
    moduleDirs = pickModules(3, 2);
    moduleOf = assign(moduleDirs);
  }

  // --- resolve imports: file edges + external deps ---
  const fileEdges: Array<[string, string]> = [];
  const externalByModule = new Map<string, Set<string>>();
  for (const [from, specs] of importsByPath) {
    if (!filePathSet.has(from)) continue;
    const fromModule = moduleOf.get(from)!;
    for (const spec of specs) {
      const res = resolveImport(from, spec, filePathSet, workspaceNameToDir, langOf.get(from) ?? null);
      if (res.file) fileEdges.push([from, res.file]);
      else if (res.external) {
        if (!externalByModule.has(fromModule)) externalByModule.set(fromModule, new Set());
        externalByModule.get(fromModule)!.add(res.external);
      }
    }
  }

  // --- pagerank ---
  const fileRank = pageRank(files.map((f) => f.path), fileEdges);

  // --- module edges ---
  const edgeWeights = new Map<string, number>();
  for (const [from, to] of fileEdges) {
    const mf = moduleOf.get(from)!;
    const mt = moduleOf.get(to)!;
    if (mf === mt) continue;
    const key = `${mf}\0${mt}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }
  const edges = [...edgeWeights.entries()].map(([key, weight]) => {
    const [from, to] = key.split("\0");
    return { from, to, weight };
  });

  // --- build defs ---
  const byModule = new Map<string, string[]>();
  for (const [path, mod] of moduleOf) {
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(path);
  }
  const modules: ModuleDef[] = [...byModule.entries()]
    .map(([path, memberPaths]) => {
      memberPaths.sort();
      const rankSum = memberPaths.reduce((s, p) => s + (fileRank.get(p) ?? 0), 0);
      return {
        path,
        name: path === "" ? "Project Root" : path,
        filePaths: memberPaths,
        facts: {
          fileCount: memberPaths.length,
          externalDeps: [...(externalByModule.get(path) ?? [])].sort(),
          entryPointCandidates: memberPaths.filter((p) =>
            ENTRY_BASENAMES.test(p.split("/").pop() ?? ""),
          ),
          memberPaths,
          rankSum,
        },
      };
    })
    .sort((a, b) => b.facts.rankSum - a.facts.rankSum);

  return { modules, edges, fileRank, moduleOf };
}

// ---------------------------------------------------------------------------
// Deterministic mermaid architecture diagram
// ---------------------------------------------------------------------------

export function moduleGraphToMermaid(
  g: ModuleGraph,
  opts: { maxNodes?: number; maxEdges?: number } = {},
): { mermaid: string; nodeIds: Map<string, string> } {
  const maxNodes = opts.maxNodes ?? 30;
  const maxEdges = opts.maxEdges ?? 60;

  let modules = g.modules;
  let edges = g.edges;
  if (modules.length > maxNodes) {
    modules = modules.slice(0, maxNodes);
    const keep = new Set(modules.map((m) => m.path));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  if (edges.length > maxEdges) {
    edges = [...edges].sort((a, b) => b.weight - a.weight).slice(0, maxEdges);
  }

  const nodeIds = new Map<string, string>();
  modules.forEach((m, i) => nodeIds.set(m.path, `m${i}`));

  const byTopDir = new Map<string, ModuleDef[]>();
  for (const m of modules) {
    const top = m.path === "" ? "(root)" : m.path.split("/")[0];
    if (!byTopDir.has(top)) byTopDir.set(top, []);
    byTopDir.get(top)!.push(m);
  }

  const lines: string[] = ["graph TD"];
  let groupIdx = 0;
  for (const [top, mods] of byTopDir) {
    const useSubgraph = byTopDir.size > 1 && mods.length > 1;
    if (useSubgraph) lines.push(`  subgraph g${groupIdx++}["${top}"]`);
    for (const m of mods) {
      const label = m.path === "" ? "Project Root" : m.path;
      lines.push(`${useSubgraph ? "    " : "  "}${nodeIds.get(m.path)}["${label}"]`);
    }
    if (useSubgraph) lines.push("  end");
  }
  for (const e of edges) {
    lines.push(`  ${nodeIds.get(e.from)} -->|${e.weight}| ${nodeIds.get(e.to)}`);
  }
  return { mermaid: lines.join("\n"), nodeIds };
}

/**
 * Prune-only validation of an LLM-returned mermaid block against the
 * deterministic original: every line must be structurally valid and reference
 * only original node ids. Returns null when the block is unacceptable.
 */
export function validatePrunedMermaid(
  candidate: string,
  originalNodeIds: Set<string>,
): string | null {
  const lines = candidate
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines[0] !== "graph TD") return null;
  const seenIds = new Set<string>();
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if (/^subgraph .+$/.test(line) || line === "end") continue;
    if ((m = /^(m\d+)\["[^"]+"\]$/.exec(line))) {
      if (!originalNodeIds.has(m[1])) return null;
      seenIds.add(m[1]);
      continue;
    }
    if ((m = /^(m\d+) -->(?:\|\d+\|)? (m\d+)$/.exec(line))) {
      if (!originalNodeIds.has(m[1]) || !originalNodeIds.has(m[2])) return null;
      continue;
    }
    return null;
  }
  if (seenIds.size === 0) return null;
  return lines.join("\n");
}
