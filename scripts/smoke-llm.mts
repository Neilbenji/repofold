// Manual smoke test: node --experimental-strip-types or tsx scripts/smoke-llm.mts
import { z } from "zod";
import { chatJson, chatText, configureLlm } from "../src/vendor/llm/client.js";

configureLlm({ flash: "qwen3:8b", pro: "qwen3:8b" });

const text = await chatText(
  "You are a terse assistant.",
  "Reply with exactly the word: ready",
  { maxTokens: 512 },
);
console.log("chatText:", JSON.stringify(text.trim().slice(0, 80)));

const schema = z.object({ language: z.string(), stars: z.number() });
const json = await chatJson(
  "Answer as JSON only.",
  'Return a JSON object: {"language": "typescript", "stars": 5}',
  schema,
  { maxTokens: 512 },
);
console.log("chatJson:", json);
