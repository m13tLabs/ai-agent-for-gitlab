import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./types.ts";

// In the job's project dir, so the CI templates can collect it as an artifact
// (the agent itself works in a ./repo checkout below it).
export function outputFile(env: Env = process.env): string {
  return join(env.CI_PROJECT_DIR || "/opt/agent", "ai-output.json");
}

export function writeOutput(success: boolean, data: Record<string, unknown> = {}, file = outputFile()) {
  const output = {
    success,
    timestamp: new Date().toISOString(),
    ...data,
  };

  writeFileSync(file, JSON.stringify(output, null, 2));
  return output;
}
