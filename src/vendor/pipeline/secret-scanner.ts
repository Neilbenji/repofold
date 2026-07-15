import path from "node:path";
import { lintSource } from "@secretlint/core";
import { creator as recommendedPreset } from "@secretlint/secretlint-rule-preset-recommend";

const config = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: recommendedPreset,
      options: {},
    },
  ],
};

export async function scanAndRedactSecrets(content: string, filePath: string) {
  const result = await lintSource({
    source: {
      content,
      filePath,
      ext: path.extname(filePath),
      contentType: "text",
    },
    options: {
      config,
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  const ranges = result.messages
    .map((message) => message.range)
    .filter((range): range is readonly [number, number] => !!range)
    .sort((a, b) => b[0] - a[0]);
  let clean = content;
  for (const [start, end] of ranges) {
    clean = clean.slice(0, start) + "[REDACTED_SECRET]" + clean.slice(end);
  }
  return { content: clean, redactions: ranges.length };
}
