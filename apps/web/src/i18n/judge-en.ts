/** The Jev judge settings card and its key types (ADR-0015). */
export const enJudge = {
  providerTypesafe: 'TypeSafe (Jev only)',
  judgeCardTitle: 'Judge (Jev)',
  judgeCardDesc:
    'A cheap decision model that checks each finding before it is published (filters false positives) and spots comments that repeat an existing one. Billed on input tokens only.',
  judgeEnabled: 'Enable the Jev judge',
  judgeProviderLabel: 'Judge provider',
  judgeModelLabel: 'Jev model',
  judgeModeLabel: 'Mode',
  judgeModeOff: 'Off (duplicate check only)',
  judgeModeAnnotate: 'Annotate (add the confidence to each comment)',
  judgeModeFilter: 'Filter (drop findings below the threshold)',
  judgeThresholdLabel: 'Threshold',
  judgeThresholdHint: 'Findings below this confidence are dropped in Filter mode and listed in the review summary.',
  judgeNoKey: 'Add a key for this provider below first.',
  judgeFallbackTitle: 'Fallback judges',
  judgeFallbackDesc:
    'Tried in order only when the judge before them fails (key, rate limit, server, timeout, wrong model). Always disclosed in the summary.',
  judgeFallbackItem: 'Fallback {index}',
  judgeAddFallback: 'Add fallback',
  judgeRemoveFallback: 'Remove fallback',
  judgeTestButton: 'Test',
  judgeTestOk: 'ok · {model} · {ms}ms',
  judgeSave: 'Save judge settings',
  judgeSaved: 'Judge settings saved',
};
