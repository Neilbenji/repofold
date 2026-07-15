/**
 * LLM client for repofold: talks to a local Ollama server through its
 * OpenAI-compatible endpoint. This file replaces the cloud client from
 * repofold-cloud (packages/core/src/llm/client.ts) while keeping the same
 * export surface, so the vendored passes stay untouched:
 *   chatText, chatJson, estimateTokens, INPUT_BUDGET_TOKENS,
 *   TruncatedOutputError, Usage, UsageSink, ChatOpts.
 *
 * The "deepseek-v4-flash" / "deepseek-v4-pro" model names hardcoded in the
 * passes are treated as ROLES and mapped onto the Ollama models configured
 * via configureLlm(): flash = the main model, pro = the planner model.
 */
import OpenAI from "openai";
import Bottleneck from "bottleneck";
import { z } from "zod";

export type LlmModel = "deepseek-v4-flash" | "deepseek-v4-pro";

export type Usage = {
  tokensIn: number;
  tokensOut: number;
  cacheHitTokens: number;
  costUsd: number;
  provider: "ollama";
  model: string;
  latencyMs: number;
  status: "ok" | "error";
};

export type UsageSink = (usage: Usage) => void | Promise<void>;

type LlmSettings = {
  baseUrl: string; // e.g. http://localhost:11434
  flash: string; // Ollama model for regular passes
  pro: string; // Ollama model for the architecture brief
  maxConcurrent: number;
};

let settings: LlmSettings = {
  baseUrl: "http://localhost:11434",
  flash: "qwen3:8b",
  pro: "qwen3:8b",
  maxConcurrent: 2,
};

let client: OpenAI | null = null;
let limiterInstance: Bottleneck | null = null;

export function configureLlm(next: Partial<LlmSettings>): void {
  settings = { ...settings, ...next };
  client = null;
  limiterInstance = null;
}

function getClient(): OpenAI {
  return (client ??= new OpenAI({
    apiKey: "ollama", // required by the SDK, ignored by Ollama
    baseURL: `${settings.baseUrl}/v1`,
    maxRetries: 3,
    timeout: 600_000, // local models can be slow
  }));
}

function limiter(): Bottleneck {
  return (limiterInstance ??= new Bottleneck({
    maxConcurrent: settings.maxConcurrent,
    minTime: 0,
  }));
}

function resolveModel(role: LlmModel | string | undefined): string {
  if (role === "deepseek-v4-pro") return settings.pro;
  return settings.flash;
}

/** Conservative input budgeting estimate; reporting always uses provider usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.4);
}

// Mutable on purpose: the passes read this binding inside function bodies, so
// setInputBudgetTokens() (from the --input-budget flag) takes effect without
// touching the vendored pass code. Local models rarely fit the 48k budget the
// cloud pipeline uses, hence the lower default.
export let INPUT_BUDGET_TOKENS = 16_000;

export function setInputBudgetTokens(tokens: number): void {
  INPUT_BUDGET_TOKENS = tokens;
}

function usageFrom(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
  latencyMs: number,
): Usage {
  return {
    tokensIn: completion.usage?.prompt_tokens ?? 0,
    tokensOut: completion.usage?.completion_tokens ?? 0,
    cacheHitTokens: 0,
    costUsd: 0,
    provider: "ollama",
    model,
    latencyMs,
    status: "ok",
  };
}

function errorUsage(model: string, latencyMs: number): Usage {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheHitTokens: 0,
    costUsd: 0,
    provider: "ollama",
    model,
    latencyMs,
    status: "error",
  };
}

export type ChatOpts = {
  model?: LlmModel;
  thinking?: boolean; // accepted for pass compatibility; not sent to Ollama
  temperature?: number;
  maxTokens?: number;
  userId?: string; // accepted for pass compatibility; never sent anywhere
  onUsage?: UsageSink;
};

function bodyOptions(opts: ChatOpts) {
  // Reasoning models (qwen3, deepseek-r1, gpt-oss) spend part of the output
  // budget on thinking tokens, which the pass-level budgets from the cloud
  // pipeline do not account for. Give every call 50% headroom; output is
  // free locally and TruncatedOutputError still catches true runaways.
  const requested = opts.maxTokens ?? 4096;
  return {
    model: resolveModel(opts.model),
    temperature: opts.temperature ?? 0.3,
    max_tokens: Math.ceil(requested * 1.5),
  };
}

export class TruncatedOutputError extends Error {
  constructor() {
    super("Model output was truncated (finish_reason=length)");
    this.name = "TruncatedOutputError";
  }
}

export function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return raw;
  return raw.slice(start, end + 1);
}

export async function chatText(system: string, user: string, opts: ChatOpts = {}) {
  const model = resolveModel(opts.model);
  const started = Date.now();
  try {
    const completion = await limiter().schedule(() =>
      getClient().chat.completions.create({
        ...bodyOptions(opts),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    );
    await opts.onUsage?.(usageFrom(completion, model, Date.now() - started));
    return completion.choices[0]?.message?.content ?? "";
  } catch (error) {
    await opts.onUsage?.(errorUsage(model, Date.now() - started));
    throw error;
  }
}

export async function chatJson<T>(
  system: string,
  user: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  opts: ChatOpts = {},
): Promise<T> {
  const run = async (extra?: string): Promise<T> => {
    const model = resolveModel(opts.model);
    const started = Date.now();
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await limiter().schedule(() =>
        getClient().chat.completions.create({
          ...bodyOptions({ ...opts, maxTokens: opts.maxTokens ?? 8192, temperature: opts.temperature ?? 0.2 }),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: extra ? `${user}\n\n${extra}` : user },
          ],
        }),
      );
    } catch (error) {
      await opts.onUsage?.(errorUsage(model, Date.now() - started));
      throw error;
    }
    await opts.onUsage?.(usageFrom(completion, model, Date.now() - started));
    const choice = completion.choices[0];
    if (choice?.finish_reason === "length") throw new TruncatedOutputError();
    const raw = choice?.message?.content ?? "";
    return schema.parse(JSON.parse(extractJsonObject(raw)));
  };

  // Local models produce invalid JSON more often than the cloud pipeline's
  // frontier models, so allow two repair rounds instead of one.
  const REPAIR_ROUNDS = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPAIR_ROUNDS; attempt++) {
    try {
      if (attempt === 0) return await run();
      const message =
        lastError instanceof Error ? lastError.message.slice(0, 500) : String(lastError);
      return await run(
        `Your previous response was invalid JSON for the required schema (${message}). Respond again with ONLY a valid JSON object.`,
      );
    } catch (error) {
      if (error instanceof TruncatedOutputError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
