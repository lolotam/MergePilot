import { run } from './main.js';

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`MergePilot failed: ${message}\n`);
  process.exitCode = 1;
});
