import type { Symbol } from "./treesitter.js";

export type DriftRemapResult =
  | { ok: true; markdown: string; remapped: number }
  | { ok: false; reason: string };

const CITE_RANGE_RE = /\[\[cite:([^\]:]+):(\d+)-(\d+)\]\]/g;

/**
 * Zero-LLM citation repair for commits that move code without changing the
 * cited symbols: rewrite [[cite:path:S-E]] line ranges by re-anchoring them to
 * the same symbols in the new revision of the file.
 *
 * Deliberately strict. A citation into a changed file is remapped only when
 * every symbol its range overlaps still exists with an identical name, kind,
 * signature AND identical line length, and all of them moved by the same
 * offset. Anything else (edited body with different length, removed/renamed
 * symbol, ambiguous duplicates, inconsistent offsets) aborts the whole remap
 * so the page goes through normal regeneration instead. Correct-but-regenerated
 * beats cheap-but-wrong.
 */
export function remapCitationDrift(args: {
  markdown: string;
  /** paths whose blob changed since the page was last written */
  changedPaths: Set<string>;
  oldSymbolsByPath: Map<string, Symbol[]>;
  newSymbolsByPath: Map<string, Symbol[]>;
}): DriftRemapResult {
  const { markdown, changedPaths, oldSymbolsByPath, newSymbolsByPath } = args;
  let remapped = 0;
  let failure: string | null = null;

  const out = markdown.replace(
    CITE_RANGE_RE,
    (whole, rawPath: string, startStr: string, endStr: string) => {
      if (failure) return whole;
      const path = rawPath.trim();
      if (!changedPaths.has(path)) return whole;

      const oldSymbols = oldSymbolsByPath.get(path);
      const newSymbols = newSymbolsByPath.get(path);
      if (!oldSymbols?.length || !newSymbols?.length) {
        failure = `no symbol data for ${path}`;
        return whole;
      }

      const s = parseInt(startStr, 10);
      const e = parseInt(endStr, 10);
      const overlapped = oldSymbols.filter((sym) => s <= sym.endLine && e >= sym.startLine);
      if (overlapped.length === 0) {
        failure = `range ${path}:${s}-${e} anchors to no known symbol`;
        return whole;
      }

      let delta: number | null = null;
      for (const oldSym of overlapped) {
        const candidates = newSymbols.filter(
          (n) =>
            n.name === oldSym.name &&
            n.kind === oldSym.kind &&
            (n.signature ?? "") === (oldSym.signature ?? "") &&
            n.endLine - n.startLine === oldSym.endLine - oldSym.startLine,
        );
        if (candidates.length !== 1) {
          failure = `${candidates.length === 0 ? "changed or removed" : "ambiguous"} symbol ${oldSym.kind} ${oldSym.name} in ${path}`;
          return whole;
        }
        const d = candidates[0].startLine - oldSym.startLine;
        if (delta === null) delta = d;
        else if (delta !== d) {
          failure = `inconsistent drift offsets inside ${path}:${s}-${e}`;
          return whole;
        }
      }

      if (delta === 0) return whole; // symbols verified in place; nothing to rewrite
      remapped++;
      return `[[cite:${path}:${s + delta!}-${e + delta!}]]`;
    },
  );

  if (failure) return { ok: false, reason: failure };
  return { ok: true, markdown: out, remapped };
}
