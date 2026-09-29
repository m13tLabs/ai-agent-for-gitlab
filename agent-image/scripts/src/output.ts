import { writeFileSync } from "node:fs";

export const OUTPUT_FILE = "/opt/agent/ai-output.json";

export function writeOutput(success: boolean, data: Record<string, unknown> = {}, file = OUTPUT_FILE) {
  const output = {
    success,
    timestamp: new Date().toISOString(),
    ...data,
  };

  writeFileSync(file, JSON.stringify(output, null, 2));
  return output;
}
