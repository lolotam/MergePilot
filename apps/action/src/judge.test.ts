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
    expect(out.judge?.mode).toBe('filter');
    expect(out.judge?.threshold).toBe(0.35);
    expect(out.judge?.judge.entries).toEqual([
      { provider: 'typesafe', model: 'jev-latest', hasKey: true },
      { provider: 'opencode-zen', model: 'jev-1.13-free', hasKey: false },
      { provider: 'vercel-gateway', model: 'typesafe-ai/jev', hasKey: false },
    ]);
    expect(out.secrets.map((s) => s.reveal())).toEqual([key('ts')]);
    expect(logs.some((l) => l.includes('OPENCODE_API_KEY') && l.includes('skipped'))).toBe(true);
    expect(logs.join('\n')).not.toContain(key('ts'));
  });

  it('formats one judge.call line without the state', () => {
    expect(
      judgeCallLine({ provider: 'typesafe', model: 'jev-latest', ok: false, code: 'auth', ms: 12, questions: 3, fallbackIndex: 0 }),
    ).toBe('judge.call provider=typesafe model=jev-latest fallback=0 questions=3 ms=12 ok=false code=auth inputTokens=0 outputTokens=0');
  });
});
