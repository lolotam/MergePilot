import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { directoryFilesOf, readFilesAtRef } from './contents.js';

describe('directoryFilesOf', () => {
  it('lists the files of a directory and its subdirectories, and leaves the other entries out', () => {
    expect(directoryFilesOf([
      { path: 'docs/guide.md', type: 'file' },
      { path: 'docs/specs', type: 'dir' },
      { path: 'docs/link.md', type: 'symlink' },
    ])).toEqual(['docs/guide.md', 'docs/specs/']);
    expect(directoryFilesOf({ type: 'file', content: '' })).toBeNull();
  });
});

describe('readFilesAtRef', () => {
  it('reads requested files and returns path and content', async () => {
    const fakeClient: Partial<GitHubClient> = {
      async getFileContent({ path, ref }) {
        if (ref !== 'base-sha-123') return null;
        if (path === '.mergepilot.yml') return 'provider: anthropic\nmodel: claude-3-5-sonnet';
        if (path === 'CLAUDE.md') return '# Guidelines';
        return null;
      },
    };

    const files = await readFilesAtRef(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      ref: 'base-sha-123',
      paths: ['.mergepilot.yml', 'CLAUDE.md'],
    });

    expect(files).toEqual([
      { path: '.mergepilot.yml', content: 'provider: anthropic\nmodel: claude-3-5-sonnet' },
      { path: 'CLAUDE.md', content: '# Guidelines' },
    ]);
  });

  it('skips missing files where getFileContent returns null', async () => {
    const fakeClient: Partial<GitHubClient> = {
      async getFileContent({ path }) {
        if (path === 'CLAUDE.md') return '# Claude Rules';
        return null; // AGENTS.md is missing
      },
    };

    const files = await readFilesAtRef(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      ref: 'sha',
      paths: ['CLAUDE.md', 'AGENTS.md'],
    });

    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ path: 'CLAUDE.md', content: '# Claude Rules' });
  });

  it('caps files exceeding 100 KB with truncate and note', async () => {
    // 120 KB content
    const largeContent = 'a'.repeat(120 * 1024);
    const fakeClient: Partial<GitHubClient> = {
      async getFileContent() {
        return largeContent;
      },
    };

    const files = await readFilesAtRef(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      ref: 'sha',
      paths: ['large-file.txt'],
    });

    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file.path).toBe('large-file.txt');
    expect(file.content).toContain('[Truncated: file exceeds 100 KB]');
    expect(file.content.startsWith('a'.repeat(100 * 1024))).toBe(true);
  });

  it('leaves files under 100 KB untouched', async () => {
    const normalContent = 'Small content under 100 KB';
    const fakeClient: Partial<GitHubClient> = {
      async getFileContent() {
        return normalContent;
      },
    };

    const files = await readFilesAtRef(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      ref: 'sha',
      paths: ['small.txt'],
    });

    expect(files).toEqual([{ path: 'small.txt', content: normalContent }]);
    expect(files[0].content).not.toContain('[Truncated');
  });

  it('returns empty array when paths is empty', async () => {
    const fakeClient: Partial<GitHubClient> = {
      async getFileContent() {
        return 'content';
      },
    };

    const files = await readFilesAtRef(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      ref: 'sha',
      paths: [],
    });

    expect(files).toEqual([]);
  });
});
