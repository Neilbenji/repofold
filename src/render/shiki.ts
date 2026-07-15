// Adapted from repofold-cloud apps/web/lib/shiki.ts (server-only import removed).
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let promise: Promise<HighlighterCore> | undefined;

/** Singleton highlighter with only the languages the generator realistically emits. */
export function getHighlighter(): Promise<HighlighterCore> {
  return (promise ??= createHighlighterCore({
    themes: [
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
    ],
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/tsx"),
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/jsx"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/bash"),
      import("@shikijs/langs/shellscript"),
      import("@shikijs/langs/sql"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/go"),
      import("@shikijs/langs/rust"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/diff"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/toml"),
      import("@shikijs/langs/docker"),
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));
}
