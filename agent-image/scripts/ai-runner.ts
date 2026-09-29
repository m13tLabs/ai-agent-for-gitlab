#!/usr/bin/env node

// Thin entrypoint that delegates to the modular runner implementation.
import { run } from "./src/runner.ts";

run().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
