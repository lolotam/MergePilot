import { describe, expect, it } from 'vitest';
import { parseRunsListQuery } from './runs-query.js';

function expectInvalid(query: Record<string, unknown>, code = 'invalid_query'): void {
  const res = parseRunsListQuery(query);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe(code);
}

describe('parseRunsListQuery', () => {
  it('applies defaults for an empty query', () => {
    const res = parseRunsListQuery({});
    expect(res).toEqual({
      ok: true,
      options: {
        limit: 50,
        offset: 0,
        repo: undefined,
        status: undefined,
        from: undefined,
        to: undefined,
        provider: undefined,
        q: undefined,
        sort: undefined,
        dir: 'desc',
      },
    });
  });

  it('parses a full valid query, single or repeated array params', () => {
    const res = parseRunsListQuery({
      limit: '20',
      offset: '40',
      repo: ['acme/a', 'acme/b'],
      status: 'failed',
      from: '2026-10-01',
      to: '2026-10-12T10:00:00Z',
      provider: 'openai',
      q: 'timeout',
      sort: 'costUsd',
      dir: 'asc',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.options.limit).toBe(20);
    expect(res.options.offset).toBe(40);
    expect(res.options.repo).toEqual(['acme/a', 'acme/b']);
    expect(res.options.status).toEqual(['failed']);
    expect(res.options.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(res.options.to?.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(res.options.sort).toBe('costUsd');
    expect(res.options.dir).toBe('asc');
  });

  it('treats a date-only `to` as the end of that UTC day, so from = to covers one day', () => {
    const res = parseRunsListQuery({ from: '2026-10-12', to: '2026-10-12' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.options.from?.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(res.options.to?.toISOString()).toBe('2026-10-12T23:59:59.999Z');
  });

  it('rejects an unknown status', () => expectInvalid({ status: ['completed', 'exploded'] }));
  it('rejects non-ISO dates', () => {
    expectInvalid({ from: 'yesterday' });
    expectInvalid({ to: '12/10/2026' });
    expectInvalid({ from: '2026-13-01' });
  });
  it('rejects from after to', () => expectInvalid({ from: '2026-10-12', to: '2026-10-01' }));
  it('rejects more than 50 repos or a repo longer than 200 chars', () => {
    expectInvalid({ repo: Array.from({ length: 51 }, (_, i) => `o/r${i}`) });
    expectInvalid({ repo: 'o/'.concat('r'.repeat(199)) });
    expect(parseRunsListQuery({ repo: Array.from({ length: 50 }, (_, i) => `o/r${i}`) }).ok).toBe(true);
  });
  it('rejects q longer than 200 chars', () => {
    expectInvalid({ q: 'a'.repeat(201) });
    expect(parseRunsListQuery({ q: 'a'.repeat(200) }).ok).toBe(true);
  });
  it('rejects a sort key outside the whitelist with invalid_sort', () => {
    expectInvalid({ sort: 'id; DROP TABLE review_runs' }, 'invalid_sort');
  });
  it('rejects an unknown dir', () => expectInvalid({ dir: 'sideways' }));
  it('rejects limit outside 1..100 and non-numeric limits', () => {
    expectInvalid({ limit: '0' });
    expectInvalid({ limit: '101' });
    expectInvalid({ limit: '-1' });
    expectInvalid({ limit: '10abc' });
    expect(parseRunsListQuery({ limit: '100' }).ok).toBe(true);
    expect(parseRunsListQuery({ limit: '1' }).ok).toBe(true);
  });
  it('rejects a negative or non-numeric offset', () => {
    expectInvalid({ offset: '-5' });
    expectInvalid({ offset: 'x' });
    expect(parseRunsListQuery({ offset: '0' }).ok).toBe(true);
  });
  it('names the bad params without echoing their values', () => {
    const marker = 'zz'.repeat(120);
    const res = parseRunsListQuery({ q: marker, status: 'nope' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('q');
    expect(res.message).toContain('status');
    expect(res.message).not.toContain(marker);
    expect(res.message).not.toContain('nope');
  });
});
