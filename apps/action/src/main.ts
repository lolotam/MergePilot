/**
 * GitHub Action entry logic. `run` reads the pull_request event, loads `.mergepilot.yml` and the
 * rules files from the BASE branch, runs the engine, and publishes one review (task C3).
 */
export async function run(): Promise<void> {
  throw new Error('MergePilot action is not implemented yet');
}
