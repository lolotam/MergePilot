import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { makeConfig, makeModel, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

// ADR-0042: the completed result carries the problems the model noticed and did not report,
// secret-redacted like the summary and the findings.

const SECRET_VALUE = 'placeholder-known-value-12345678';

function input(model: ReturnType<typeof makeModel>, knownSecrets: Secret[] = []) {
  return {
    config: makeConfig(),
    pr: { title: 'T', body: 'B' },
    files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model,
    knownSecrets,
  };
}

describe('runReview — withheld (ADR-0042)', () => {
  it('carries the withheld items with the known secrets redacted', async () => {
    const secret = new Secret(SECRET_VALUE);
    const model = makeModel(
      JSON.stringify({
        summary: 'Looks good.',
        findings: [],
        withheld: [
          { title: `hardcoded ${SECRET_VALUE}`, reason: `it leaks ${SECRET_VALUE}` },
          { title: 'Slow query', reason: 'below the confidence bar' },
        ],
      }),
    );

    const result = await runReview(input(model, [secret]));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.withheld).toHaveLength(2);
    expect(result.withheld?.[0]?.title).toContain('[REDACTED:known]');
    expect(result.withheld?.[0]?.title).not.toContain(SECRET_VALUE);
    expect(result.withheld?.[0]?.reason).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(result.withheld)).not.toContain(SECRET_VALUE);
    expect(result.withheld?.[1]?.title).toBe('Slow query');
  });

  it('has no withheld key when the answer withheld nothing', async () => {
    const model = makeModel(JSON.stringify({ summary: 'Looks good.', findings: [] }));

    const result = await runReview(input(model));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect('withheld' in result).toBe(false);
  });

  it('redacts a known secret that contains a line break', async () => {
    const secretValue = 'known value  with\nbreak-1234567';
    const secret = new Secret(secretValue);
    const model = makeModel(
      JSON.stringify({
        summary: 'Looks good.',
        findings: [],
        withheld: [{ title: `hardcoded ${secretValue}`, reason: `it leaks ${secretValue}` }],
      }),
    );

    const result = await runReview(input(model, [secret]));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.withheld?.[0]?.title).toContain('[REDACTED:known]');
    expect(result.withheld?.[0]?.reason).toContain('[REDACTED:known]');
    expect(JSON.stringify(result.withheld)).not.toContain('break-1234567');
  });
});
