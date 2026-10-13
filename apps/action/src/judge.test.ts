import { describe, expect, it } from 'vitest';
import { MergePilotConfigSchema } from '@mergepilot/engine';
import { actionJudge, judgeCallLine } from './judge.js';

const key = (tag: string): string => ['tk', tag, 'r5'.repeat(8)].join('-');

function config(judge?: Record<string, unknown>) {
  return MergePilotConfigSchema.parse({ provider: 'anthropic', model: 'claude-x', ...(judge ? { judge } : {}) });
}

describe('actionJudge', () => {
  it('is absent without a judge section', () => {
    expect(actionJudge(config(), {}, () => undefined)).toEqual({ secrets: [] });
  });

  it('reads each entry key from its env name and discloses a missing one', () => {
    const logs: string[] = [];
    const env = { TYPESAFE_API_KEY: key('ts'), OPENCODE_API_KEY: '  ' };
    const out = actionJudge(
      config({ provider: 'typesafe', mode: 'filter', fallback: [{ provider: 'opencode-zen' }, { provider: 'vercel-gateway' }] }),
      env,
      (m) => logs.push(m),
    );
    // The old single mode still works: filter -> filter + dedupe.
    expect(out.judge?.uses).toEqual(['filter', 'dedupe']);
    expect(out.judge?.threshold).toBe(0.35);
    expect(out.judge?.judge.entries).toEqual([
      { provider: 'typesafe', model: 'jev-latest', hasKey: true },
      { provider: 'opencode-zen', model: 'jev-1.13-free', hasKey: false },
      { provider: 'vercel-gateway', model: 'typesafe-ai/jev', hasKey: false },
    ]);
    expect(out.secrets.map((s) => s.reveal())).toEqual([key('ts')]);
    expect(logs.some((l) => l.includes('OPENCODE_API_KEY') && l.includes('skipped'))).toBe(true);
    expect(logs.join('\n')).not.toContain(key('ts'));
    expect(logs.some((l) => l.includes('uses filter, dedupe'))).toBe(true);
  });

  it('passes the configured uses through, and says when an enabled judge has none', () => {
    const logs: string[] = [];
    const out = actionJudge(config({ provider: 'typesafe', uses: ['annotate', 'filter'] }), {}, (m) => logs.push(m));
    expect(out.judge?.uses).toEqual(['annotate', 'filter']);
    actionJudge(config({ provider: 'typesafe', uses: [] }), {}, (m) => logs.push(m));
    expect(logs.some((l) => l.includes('uses none'))).toBe(true);
  });

  it('formats one judge.call line without the state', () => {
    expect(
      judgeCallLine({ provider: 'typesafe', model: 'jev-latest', ok: false, code: 'auth', ms: 12, questions: 3, fallbackIndex: 0 }),
    ).toBe('judge.call provider=typesafe model=jev-latest fallback=0 questions=3 ms=12 ok=false code=auth inputTokens=0 outputTokens=0');
  });
});
