import type { ReviewRunResult } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { runPriceLabel } from '../settings/price-format.js';

export interface RunCostProps {
  costUsd: number | null;
  /** `result.pricing` (ADR-0016): which source priced the run's primary model; absent on older runs. */
  pricing?: ReviewRunResult['pricing'] | undefined;
}

/** The run's cost, followed by a small "· OpenRouter price" / "· price unknown" when known. */
export function RunCost({ costUsd, pricing }: RunCostProps) {
  const { t } = useI18n();
  return (
    <div data-testid="run-cost" className="font-mono text-sm font-bold text-ink-900 dark:text-ink-100">
      {costUsd !== null ? `$${costUsd.toFixed(4)}` : '—'}
      {pricing ? (
        <span className="font-sans text-[10px] font-normal text-ink-500 dark:text-ink-400">
          {' · '}
          {runPriceLabel(pricing.source, t)}
        </span>
      ) : null}
    </div>
  );
}
