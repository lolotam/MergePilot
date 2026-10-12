import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment } from './client.js';
import {
  areTitlesSimilar,
  computeFindingFingerprint,
  deduplicateFindings,
  normalizeTitle,
  parseFingerprintFromComment,
  parseTitleFromComment,
} from './dedupe.js';
import { renderFindingComment } from './render.js';

describe('fingerprint utilities', () => {
  const finding: Finding = {
    id: 'f-1',
    path: 'src/auth/jwt.ts',
    line: 42,
    side: 'RIGHT',
    title: '  Potential SQL Injection: User Input!  ',
    body: 'Sanitize query.',
    severity: 'critical',
    category: 'security',
    evidence: 'db.query(user)',
    confidence: 0.99,
    ruleRef: 'CLAUDE.md §5',
  };

  it('normalizes title by trimming, lowercasing, and stripping punctuation', () => {
    expect(normalizeTitle('  Potential SQL Injection: User Input!  ')).toBe('potential sql injection user input');
    expect(normalizeTitle('ثغرة أمنية: حقن SQL!')).toBe('ثغرة أمنية حقن sql');
  });

  it('computes stable fingerprint for finding regardless of title whitespace/case', () => {
    const fp1 = computeFindingFingerprint(finding);
    const fp2 = computeFindingFingerprint({
      ...finding,
      title: 'potential sql injection user input',
    });
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(fp1.length).toBeGreaterThanOrEqual(8);
  });

  it('parses fingerprint marker from comment body', () => {
    const commentBody = 'Some text\n\n<!-- mp:f=abc123def456 -->';
    expect(parseFingerprintFromComment(commentBody)).toBe('abc123def456');
    expect(parseFingerprintFromComment('No marker here')).toBeNull();
  });

  it('parses title from rendered markdown comment body', () => {
    const commentBody = '### Potential SQL injection\n\n**Severity:** `HIGH`\n\nBody text';
    expect(parseTitleFromComment(commentBody)).toBe('Potential SQL injection');
    expect(parseTitleFromComment('No heading')).toBeNull();
  });

  it('areTitlesSimilar detects exact, normalized, and high token overlap titles', () => {
    expect(areTitlesSimilar('SQL injection risk', 'sql injection risk')).toBe(true);
    expect(areTitlesSimilar('SQL injection risk in auth query', 'SQL injection risk in query')).toBe(true);
    expect(areTitlesSimilar('SQL injection', 'Completely unrelated buffer overflow')).toBe(false);
  });

  it('renderFindingComment includes hidden fingerprint marker', () => {
    const rendered = renderFindingComment(finding, { language: 'en', suggestionsAsCode: false });
    const fp = computeFindingFingerprint(finding);
    expect(rendered).toContain(`<!-- mp:f=${fp} -->`);
    expect(parseFingerprintFromComment(rendered)).toBe(fp);
  });
});

describe('deduplicateFindings', () => {
  const publisherLogin = 'github-actions[bot]';

  const baseFinding: Finding = {
    id: 'f-test',
    path: 'src/main.ts',
    line: 50,
    side: 'RIGHT',
    title: 'Missing null check',
    body: 'Variable may be null.',
    severity: 'high',
    category: 'correctness',
    evidence: 'foo.bar()',
    confidence: 0.9,
  };

  it('drops finding when existing comment has same path, overlapping line, and matching fingerprint', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const existingComments: GitHubReviewComment[] = [
      {
        id: 101,
        path: 'src/main.ts',
        line: 50,
        start_line: 48,
        body: `### Missing null check\n\nSome body\n\n<!-- mp:f=${fp} -->`,
        user: { login: publisherLogin },
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.id).toBe('f-test');
    expect(kept).toHaveLength(0);
  });

  it('keeps finding when line ranges do not overlap despite same path and title', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const existingComments: GitHubReviewComment[] = [
      {
        id: 101,
        path: 'src/main.ts',
        line: 20, // Different line range (20 vs 50)
        start_line: 18,
        body: `### Missing null check\n\n<!-- mp:f=${fp} -->`,
        user: { login: publisherLogin },
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('keeps finding when path differs despite overlapping line and matching fingerprint', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const existingComments: GitHubReviewComment[] = [
      {
        id: 101,
        path: 'src/other.ts', // Different path
        line: 50,
        body: `### Missing null check\n\n<!-- mp:f=${fp} -->`,
        user: { login: publisherLogin },
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('falls back to title similarity when existing comment lacks fingerprint marker', async () => {
    const existingComments: GitHubReviewComment[] = [
      {
        id: 102,
        path: 'src/main.ts',
        line: 50,
        // Pre-migration comment without fingerprint marker
        body: '### Missing null check\n\n**Severity:** `HIGH`\n\nVariable may be null.',
        user: { login: publisherLogin },
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(dropped).toHaveLength(1);
    expect(kept).toHaveLength(0);
  });

  it('does not drop when title-similarity fallback finds different title on same line', async () => {
    const existingComments: GitHubReviewComment[] = [
      {
        id: 103,
        path: 'src/main.ts',
        line: 50,
        body: '### Insecure cryptographic hash algorithm\n\nUse SHA256.',
        user: { login: publisherLogin },
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('ignores comments posted by other users', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const existingComments: GitHubReviewComment[] = [
      {
        id: 104,
        path: 'src/main.ts',
        line: 50,
        body: `### Missing null check\n\n<!-- mp:f=${fp} -->`,
        user: { login: 'some-contributor' }, // Different user
      },
    ];

    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return existingComments;
      },
    };

    const { kept, dropped } = await deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [baseFinding],
    });

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  const dedupeWith = async (comments: GitHubReviewComment[], finding: Finding = baseFinding) => {
    const client: Partial<GitHubClient> = {
      async listReviewCommentsPage() {
        return comments;
      },
    };
    return deduplicateFindings(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      findings: [finding],
    });
  };

  it('drops a reworded finding whose fingerprint differs but whose title is near-identical', async () => {
    const oldFp = computeFindingFingerprint({ ...baseFinding, title: 'Missing null check here' });
    const { dropped } = await dedupeWith([
      {
        id: 105,
        path: 'src/main.ts',
        line: 50,
        body: `### Missing null check here\n\n<!-- mp:f=${oldFp} -->`,
        user: { login: publisherLogin },
      },
    ]);
    expect(dropped).toHaveLength(1);
  });

  it('trusts a fingerprint posted by another MergePilot bot account (Action vs App)', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const { dropped } = await dedupeWith([
      { id: 106, path: 'src/main.ts', line: 50, body: `<!-- mp:f=${fp} -->`, user: { login: 'mergepilot[bot]' } },
    ]);
    expect(dropped).toHaveLength(1);
  });

  it("ignores another bot's comment without a fingerprint (title match alone is not enough)", async () => {
    const { kept } = await dedupeWith([
      { id: 107, path: 'src/main.ts', line: 50, body: '### Missing null check', user: { login: 'other[bot]' } },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('uses original_line for an outdated comment', async () => {
    const fp = computeFindingFingerprint(baseFinding);
    const { dropped } = await dedupeWith([
      {
        id: 108,
        path: 'src/main.ts',
        line: null,
        original_line: 50,
        body: `<!-- mp:f=${fp} -->`,
        user: { login: publisherLogin },
      },
    ]);
    expect(dropped).toHaveLength(1);
  });
});
