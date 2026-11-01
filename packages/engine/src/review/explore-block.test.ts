import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { estimateTokens } from './budget.js';
import { fitExploredEntries, renderExploredBlock } from './explore-block.js';

describe('exploration evidence fitting', () => {
  it.each([100, 150])('redacts credentials before a %s-token cut through a path', (cap) => {
    const secret = new Secret('pr188Credential'.repeat(30));
    const entries = [{ label: `find: ${secret.reveal()}`, content: `src/${secret.reveal()}.ts\n${'padding '.repeat(1000)}` }];
    const fitted = fitExploredEntries(entries, [secret], cap);
    const rendered = renderExploredBlock(fitted, [secret]);

    expect(fitted).toHaveLength(1);
    expect(rendered).toContain('[REDACTED:known]');
    expect(JSON.stringify(fitted)).not.toContain('pr188Credential');
    expect(rendered).toContain('[explored result truncated');
    expect(rendered).toContain('<<<END UNTRUSTED:');
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(cap);
  });
});
