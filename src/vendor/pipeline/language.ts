const EXT_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".zig": "zig",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
  ".graphql": "graphql",
  ".proto": "protobuf",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".gd": "gdscript",
};

const SHEBANG_MAP: Array<[RegExp, string]> = [
  [/\b(python3?|python)\b/, "python"],
  [/\bnode\b/, "javascript"],
  [/\b(bash|sh|zsh)\b/, "shell"],
  [/\bruby\b/, "ruby"],
  [/\bperl\b/, "perl"],
];

export function detectLanguage(path: string, content?: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i >= 0) {
    const lang = EXT_MAP[base.slice(i).toLowerCase()];
    if (lang) return lang;
  }
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  if (base.toLowerCase() === "makefile") return "makefile";
  if (content && content.startsWith("#!")) {
    const first = content.slice(0, content.indexOf("\n"));
    for (const [re, lang] of SHEBANG_MAP) if (re.test(first)) return lang;
  }
  return "other";
}
