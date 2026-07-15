import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type Symbol = {
  name: string;
  kind: string; // function|class|method|interface|type|enum|const
  signature: string;
  startLine: number; // 1-indexed
  endLine: number;
  exported: boolean;
};

export type Extraction = {
  symbols: Symbol[];
  imports: string[];
  skeleton: string;
};

const WASM_BY_LANGUAGE: Record<string, string> = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-tsx",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
};

// Memoize the PROMISES, not the results: concurrent first calls (page pool)
// must share one Parser.init() and one Language.load() per grammar. A second
// in-flight init corrupts the wasm module ("Incompatible language version 0").
const parserPromises = new Map<string, Promise<Parser>>();
let initPromise: Promise<unknown> | null = null;

function getParser(language: string): Promise<Parser | null> {
  const wasmName = WASM_BY_LANGUAGE[language];
  if (!wasmName) return Promise.resolve(null);
  let pending = parserPromises.get(language);
  if (!pending) {
    pending = (async () => {
      initPromise ??= Parser.init();
      await initPromise;
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmName}.wasm`);
      const lang = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    })();
    parserPromises.set(language, pending);
    pending.catch(() => parserPromises.delete(language));
  }
  return pending;
}

const MAX_SYMBOLS_PER_FILE = 200;
const MAX_PARSE_BYTES = 512 * 1024;

/** Extract symbols, imports and a skeleton (bodies replaced by "…"). */
export async function extractStructure(
  language: string,
  content: string,
): Promise<Extraction> {
  if (Buffer.byteLength(content) > MAX_PARSE_BYTES) {
    return regexFallback(language, content);
  }
  const parser = await getParser(language).catch(() => null);
  if (!parser) return regexFallback(language, content);

  const tree = parser.parse(content);
  if (!tree) return regexFallback(language, content);
  try {
    const isJsFamily = language !== "python";
    return isJsFamily
      ? extractJsFamily(tree.rootNode, content)
      : extractPython(tree.rootNode, content);
  } finally {
    tree.delete();
  }
}

// ---------- JS / TS / TSX ----------

const JS_DECL_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

function jsKind(type: string): string {
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("type_alias")) return "type";
  if (type.includes("enum")) return "enum";
  return "function";
}

function extractJsFamily(root: Node, content: string): Extraction {
  const symbols: Symbol[] = [];
  const imports: string[] = [];
  const bodyRanges: Array<[number, number]> = []; // char index ranges to elide

  const addSymbol = (node: Node, kind: string, exported: boolean, nameNode?: Node | null) => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    const name = (nameNode ?? node.childForFieldName("name"))?.text ?? "(anonymous)";
    const body = node.childForFieldName("body");
    const sigEnd = body ? body.startIndex : node.endIndex;
    const signature = content
      .slice(node.startIndex, Math.min(sigEnd, node.startIndex + 300))
      .replace(/\s+/g, " ")
      .trim();
    symbols.push({
      name,
      kind,
      signature,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported,
    });
  };

  const elideBody = (node: Node) => {
    const body = node.childForFieldName("body");
    if (body && body.type === "statement_block" && body.endIndex - body.startIndex > 80) {
      bodyRanges.push([body.startIndex + 1, body.endIndex - 1]); // keep braces
    }
  };

  const visit = (node: Node, exported: boolean, depth: number) => {
    if (node.type === "import_statement") {
      const src = node.childForFieldName("source");
      if (src) imports.push(src.text.replace(/^['"]|['"]$/g, ""));
      return;
    }
    if (node.type === "export_statement") {
      for (const child of node.namedChildren) if (child) visit(child, true, depth);
      return;
    }
    if (JS_DECL_TYPES.has(node.type)) {
      addSymbol(node, jsKind(node.type), exported);
      if (node.type.includes("class")) {
        // methods inside class bodies
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            if (member?.type === "method_definition" && symbols.length < MAX_SYMBOLS_PER_FILE) {
              addSymbol(member, "method", exported);
              elideBody(member);
            }
          }
        }
      } else {
        elideBody(node);
      }
      return;
    }
    // top-level const foo = (…) => …  /  const foo = function …
    if (
      (node.type === "lexical_declaration" || node.type === "variable_declaration") &&
      depth <= 1
    ) {
      for (const decl of node.namedChildren) {
        if (decl?.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        if (!value) continue;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          addSymbol(node, "function", exported, decl.childForFieldName("name"));
          const body = value.childForFieldName("body");
          if (body && body.type === "statement_block" && body.endIndex - body.startIndex > 80) {
            bodyRanges.push([body.startIndex + 1, body.endIndex - 1]);
          }
        } else if (depth === 0 && exported) {
          addSymbol(node, "const", exported, decl.childForFieldName("name"));
        }
      }
      return;
    }
    if (depth < 3) {
      for (const child of node.namedChildren) if (child) visit(child, exported, depth + 1);
    }
  };

  for (const child of root.namedChildren) if (child) visit(child, false, 0);

  return { symbols, imports, skeleton: buildSkeleton(content, bodyRanges, " … ") };
}

// ---------- Python ----------

function extractPython(root: Node, content: string): Extraction {
  const symbols: Symbol[] = [];
  const imports: string[] = [];
  const bodyRanges: Array<[number, number]> = [];

  const addDef = (node: Node, kind: string, parentName?: string) => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    const nameNode = node.childForFieldName("name");
    const rawName = nameNode?.text ?? "(anonymous)";
    const name = parentName ? `${parentName}.${rawName}` : rawName;
    const body = node.childForFieldName("body");
    const sigEnd = body ? body.startIndex : node.endIndex;
    const signature = content
      .slice(node.startIndex, Math.min(sigEnd, node.startIndex + 300))
      .replace(/\s+/g, " ")
      .trim();
    symbols.push({
      name,
      kind,
      signature,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: !rawName.startsWith("_"),
    });
    if (kind !== "class" && body && body.endIndex - body.startIndex > 120) {
      // keep a possible docstring (first child if it's a string expression)
      const first = body.namedChildren[0];
      const keepUntil =
        first?.type === "expression_statement" && first.namedChildren[0]?.type === "string"
          ? first.endIndex
          : body.startIndex;
      if (body.endIndex - keepUntil > 120) bodyRanges.push([keepUntil, body.endIndex]);
    }
  };

  const visit = (node: Node, parentName?: string) => {
    let target = node;
    if (node.type === "decorated_definition") {
      const def = node.namedChildren.find(
        (c) => c?.type === "function_definition" || c?.type === "class_definition",
      );
      if (def) target = def;
    }
    if (target.type === "import_statement" || target.type === "import_from_statement") {
      const mod = target.childForFieldName("module_name") ?? target.namedChildren[0];
      if (mod) imports.push(mod.text);
      return;
    }
    if (target.type === "function_definition") {
      addDef(target, parentName ? "method" : "function", parentName);
      return;
    }
    if (target.type === "class_definition") {
      addDef(target, "class");
      const body = target.childForFieldName("body");
      const className = target.childForFieldName("name")?.text;
      if (body) for (const child of body.namedChildren) if (child) visit(child, className);
      return;
    }
  };

  for (const child of root.namedChildren) if (child) visit(child);

  return { symbols, imports, skeleton: buildSkeleton(content, bodyRanges, "\n        ...\n") };
}

// ---------- shared ----------

function buildSkeleton(
  content: string,
  ranges: Array<[number, number]>,
  replacement: string,
): string {
  if (ranges.length === 0) return content;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue; // skip nested/overlapping
    out += content.slice(cursor, start) + replacement;
    cursor = end;
  }
  out += content.slice(cursor);
  return out;
}

/** Crude but grounded fallback for languages without a grammar. */
export function regexFallback(language: string, content: string): Extraction {
  const lines = content.split("\n");
  const symbols: Symbol[] = [];
  const imports: string[] = [];

  const defRe =
    /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*(?:def|func|function|fn|class|interface|struct|trait|impl|enum|type|module|sub)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const importRe =
    /^\s*(?:import|from|use|require|include|using)\b\s+([^\s;]+)/;

  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; i++) {
    const m = defRe.exec(lines[i]);
    if (m) {
      symbols.push({
        name: m[1],
        kind: "definition",
        signature: lines[i].trim().slice(0, 300),
        startLine: i + 1,
        endLine: i + 1,
        exported: true,
      });
    }
    const im = importRe.exec(lines[i]);
    if (im && imports.length < 100) imports.push(im[1]);
  }

  const head = lines.slice(0, 40).join("\n");
  const sigLines = symbols.map((s) => `L${s.startLine}: ${s.signature}`).join("\n");
  const tail = lines.length > 60 ? lines.slice(-10).join("\n") : "";
  const skeleton = [head, "…", sigLines, "…", tail].filter(Boolean).join("\n");

  return { symbols, imports, skeleton };
}
