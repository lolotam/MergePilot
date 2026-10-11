import type { ActionDeps } from './deps.js';

/**
 * Full-repository audit, triggered by `workflow_dispatch` or `schedule` (task D5).
 */
export async function runAudit(deps?: ActionDeps): Promise<void> {
  const log = deps?.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  log('MergePilot audit is not implemented yet');
}
