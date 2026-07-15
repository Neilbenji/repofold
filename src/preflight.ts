import type { RepofoldConfig } from "./config.js";

type OllamaTag = { name: string; model?: string };

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} responded with ${res.status}`);
  return res.json();
}

function modelPresent(tags: OllamaTag[], wanted: string): boolean {
  return tags.some((t) => t.name === wanted || t.name === `${wanted}:latest` || t.model === wanted);
}

/** Reads the model's maximum context length from /api/show, if reported. */
async function contextLength(ollamaUrl: string, model: string): Promise<number | null> {
  try {
    const info = (await fetchJson(`${ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    })) as { model_info?: Record<string, unknown> };
    for (const [key, value] of Object.entries(info.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number") return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies the Ollama server is reachable and the configured models are
 * pulled, and warns loudly when the context window looks too small for the
 * configured input budget - the single most common failure mode.
 */
export async function preflight(config: RepofoldConfig): Promise<void> {
  let tags: OllamaTag[];
  try {
    const data = (await fetchJson(`${config.ollamaUrl}/api/tags`)) as { models?: OllamaTag[] };
    tags = data.models ?? [];
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${config.ollamaUrl}.\n` +
        `Is it running? Start it with "ollama serve" or install it from https://ollama.com.`,
    );
  }

  const models = [...new Set([config.model, config.plannerModel])];
  for (const model of models) {
    if (!modelPresent(tags, model)) {
      throw new Error(`Model "${model}" is not available in Ollama. Run: ollama pull ${model}`);
    }
  }

  for (const model of models) {
    const ctx = await contextLength(config.ollamaUrl, model);
    const needed = Math.ceil(config.inputBudget * 1.4);
    if (ctx !== null && ctx < needed) {
      console.warn(
        `\nWARNING: model "${model}" reports a maximum context of ${ctx} tokens, but the\n` +
          `configured input budget of ${config.inputBudget} tokens needs roughly ${needed} including\n` +
          `output headroom. Note that Ollama often serves models with a DEFAULT context\n` +
          `window of 4096 regardless of the model maximum. To raise it, restart Ollama with:\n` +
          `  OLLAMA_CONTEXT_LENGTH=${Math.max(needed, 16384)} ollama serve\n` +
          `or lower the budget with --input-budget. Generation continues, but truncated\n` +
          `prompts produce poor pages.\n`,
      );
    }
  }
}
