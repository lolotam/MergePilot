import {
  createJudge,
  judgeChainOf,
  JUDGE_PROVIDERS,
  Secret,
  type JudgeCallEvent,
  type JudgeEntry,
  type MergePilotConfig,
} from '@mergepilot/engine';
import type { ReviewJudge } from '@mergepilot/github';

/** One `judge.call` line per attempt: provider, model, counts and timing only, never the state. */
export function judgeCallLine(event: JudgeCallEvent): string {
  const parts = [
    `provider=${event.provider}`,
    `model=${event.model}`,
    `fallback=${event.fallbackIndex}`,
    `questions=${event.questions}`,
    `ms=${event.ms}`,
    event.ok ? 'ok=true' : `ok=false code=${event.code ?? 'error'}`,
    `inputTokens=${event.inputTokens ?? 0}`,
    `outputTokens=${event.outputTokens ?? 0}`,
  ];
  return `judge.call ${parts.join(' ')}`;
}

/**
 * The Jev judge from `.mergepilot.yml` `judge:` (ADR-0015). Keys come from the environment
 * (TYPESAFE_API_KEY, AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, OPENCODE_API_KEY); an entry without
 * its key is skipped and disclosed. Returns the keys too, so they are redacted like every other.
 */
export function actionJudge(
  config: MergePilotConfig,
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): { judge?: ReviewJudge | undefined; secrets: Secret[] } {
  if (!config.judge) return { secrets: [] };
  const secrets: Secret[] = [];
  const entries: JudgeEntry[] = judgeChainOf(config.judge).map((entry) => {
    const raw = env[JUDGE_PROVIDERS[entry.provider].envName]?.trim();
    if (!raw) {
      log(`Jev judge ${entry.provider}:${entry.model} has no key (${JUDGE_PROVIDERS[entry.provider].envName}); it will be skipped`);
      return entry;
    }
    const apiKey = new Secret(raw);
    secrets.push(apiKey);
    return { ...entry, apiKey };
  });
  const judge = createJudge({ entries, onCall: (event) => log(judgeCallLine(event)) });
  log(`Jev judge: ${judge.label} (mode ${config.judge.mode}, threshold ${config.judge.threshold}, ${entries.length - 1} fallbacks)`);
  return { judge: { judge, mode: config.judge.mode, threshold: config.judge.threshold }, secrets };
}
