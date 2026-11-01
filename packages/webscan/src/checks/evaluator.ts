/**
 * The evaluator of the six catalogue checks (ADR-0052 section 3).
 *
 * The evaluator runs the checks in their catalogue order and publishes the
 * result of every check as soon as the check is done. A check that fails or
 * that stops the scan therefore never takes away the findings of the checks
 * that already finished.
 *
 * A check that is switched off evaluates nothing. It reports that it did not
 * run, and it never claims an issue id.
 */

import {
  CHECK_IDS,
  type CheckEvaluation,
  type CheckEvaluationContext,
  type CheckEvaluator,
} from '../evaluation.js';
import type { CheckId } from '../types.js';
import { evaluateActive } from './active.js';
import { evaluateCookies } from './cookies.js';
import { evaluateDisclosure } from './disclosure.js';
import { evaluateFiles } from './files.js';
import { evaluateHeaders } from './headers.js';
import { evaluateTransport } from './transport.js';
import { coverageRow } from './shared.js';

/** The checks of the catalogue and the function that evaluates them. */
const CHECKS: Readonly<
  Record<CheckId, (context: CheckEvaluationContext) => Promise<readonly CheckEvaluation[]>>
> = {
  headers: evaluateHeaders,
  cookies: evaluateCookies,
  transport: evaluateTransport,
  disclosure: evaluateDisclosure,
  files: evaluateFiles,
  active: evaluateActive,
};

/**
 * The rows of a check that is switched off.
 *
 * The rows record that the check did not run. They claim no issue id, so they
 * can never be mistaken for coverage.
 */
function disabledEvaluations(
  context: CheckEvaluationContext,
  checkId: CheckId,
): readonly CheckEvaluation[] {
  return context.targets.map((target) => ({
    coverage: coverageRow({
      targetKey: target.targetKey,
      checkId,
      evaluatedIssueIds: [],
      outcome: 'not-visited' as const,
      reason: 'disabled' as const,
    }),
    findings: [],
  }));
}

/**
 * The evaluator of the catalogue checks.
 *
 * It emits every evaluation it produced and returns none, so the run keeps
 * exactly one copy of each row.
 */
export const CATALOGUE_CHECK_EVALUATOR: CheckEvaluator = Object.freeze({
  evaluate: async (context: CheckEvaluationContext): Promise<readonly CheckEvaluation[]> => {
    for (const checkId of CHECK_IDS) {
      if (!context.checks[checkId]) {
        context.emit(disabledEvaluations(context, checkId));
        continue;
      }
      context.emit(await CHECKS[checkId](context));
    }
    return [];
  },
});
