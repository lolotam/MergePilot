import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import {
  executePauseCommand,
  isAuthorizedToControlPause,
  isPrPaused,
  parsePauseCommand,
  parsePauseCommandWithLanguage,
  postPauseNoticeOnce,
} from './pause.js';

describe('parsePauseCommand', () => {
  it('parses English pause command', () => {
    expect(parsePauseCommand('@mergepilot pause')).toBe('pause');
    expect(parsePauseCommand('  @mergepilot pause  ')).toBe('pause');
    expect(parsePauseCommand('@MERGEPILOT PAUSE')).toBe('pause');
    expect(parsePauseCommand('Please hold on: @mergepilot pause thanks')).toBe('pause');
  });

  it('parses English resume command', () => {
    expect(parsePauseCommand('@mergepilot resume')).toBe('resume');
    expect(parsePauseCommand('@mergepilot RESUME')).toBe('resume');
  });

  it('parses Arabic pause command (إيقاف)', () => {
    expect(parsePauseCommand('@mergepilot إيقاف')).toBe('pause');
    expect(parsePauseCommand('من فضلك @mergepilot إيقاف الآن')).toBe('pause');
  });

  it('parses Arabic resume command (استئناف)', () => {
    expect(parsePauseCommand('@mergepilot استئناف')).toBe('resume');
    expect(parsePauseCommand('تمام @mergepilot استئناف')).toBe('resume');
  });

  it('returns null for non-commands and other mentions', () => {
    expect(parsePauseCommand('@mergepilot help')).toBeNull();
    expect(parsePauseCommand('@otherbot pause')).toBeNull();
    expect(parsePauseCommand('Just discussing @mergepilot in general')).toBeNull();
    expect(parsePauseCommand('')).toBeNull();
  });

  it('accepts trailing punctuation and reports the reply language', () => {
    expect(parsePauseCommand('@mergepilot pause.')).toBe('pause');
    expect(parsePauseCommandWithLanguage('@mergepilot resume!')).toEqual({ command: 'resume', language: 'en' });
    expect(parsePauseCommandWithLanguage('@mergepilot إيقاف')).toEqual({ command: 'pause', language: 'ar' });
    expect(parsePauseCommandWithLanguage('@mergepilot استئناف،')).toEqual({ command: 'resume', language: 'ar' });
  });

  it("never matches the bot's own replies, which quote the command in backticks", () => {
    expect(parsePauseCommand('To resume, comment `@mergepilot resume`.')).toBeNull();
    expect(parsePauseCommand('اكتب `@mergepilot استئناف` للاستئناف')).toBeNull();
    expect(parsePauseCommand('@mergepilot pauseall')).toBeNull();
  });
});

describe('isAuthorizedToControlPause', () => {
  it('authorizes the repository OWNER from author_association without an API call', async () => {
    const client: Partial<GitHubClient> = {};
    expect(
      await isAuthorizedToControlPause(client as GitHubClient, {
        owner: 'acme',
        repo: 'repo',
        username: 'alice',
        authorAssociation: 'OWNER',
      }),
    ).toBe(true);
  });

  it('does not trust MEMBER / COLLABORATOR associations: write access comes from the permission API', async () => {
    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission({ username }) {
        return { permission: username === 'charlie' ? 'write' : 'read' };
      },
    };
    const check = (username: string, authorAssociation: string) =>
      isAuthorizedToControlPause(client as GitHubClient, { owner: 'acme', repo: 'repo', username, authorAssociation });

    expect(await check('bob', 'MEMBER')).toBe(false);
    expect(await check('dora', 'COLLABORATOR')).toBe(false);
    expect(await check('charlie', 'COLLABORATOR')).toBe(true);
  });

  it('accepts maintain permission and denies when the permission API fails', async () => {
    const maintain: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'maintain' };
      },
    };
    const failing: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        throw new Error('404');
      },
    };
    const params = { owner: 'acme', repo: 'repo', username: 'erin' };
    expect(await isAuthorizedToControlPause(maintain as GitHubClient, params)).toBe(true);
    expect(await isAuthorizedToControlPause(failing as GitHubClient, params)).toBe(false);
  });

  it('rejects unprivileged author_association when collaborator check also denies or missing', async () => {
    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'read' };
      },
    };
    expect(
      await isAuthorizedToControlPause(client as GitHubClient, {
        owner: 'acme',
        repo: 'repo',
        username: 'dave',
        authorAssociation: 'CONTRIBUTOR',
      }),
    ).toBe(false);
  });

  it('authorizes write or admin collaborator permission', async () => {
    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission({ username }) {
        if (username === 'maintainer') return { permission: 'write' };
        if (username === 'admin') return { permission: 'admin' };
        return { permission: 'read' };
      },
    };

    expect(
      await isAuthorizedToControlPause(client as GitHubClient, {
        owner: 'acme',
        repo: 'repo',
        username: 'maintainer',
      }),
    ).toBe(true);

    expect(
      await isAuthorizedToControlPause(client as GitHubClient, {
        owner: 'acme',
        repo: 'repo',
        username: 'admin',
      }),
    ).toBe(true);

    expect(
      await isAuthorizedToControlPause(client as GitHubClient, {
        owner: 'acme',
        repo: 'repo',
        username: 'viewer',
      }),
    ).toBe(false);
  });
});

describe('isPrPaused', () => {
  const publisherLogin = 'github-actions[bot]';

  it('returns true when PR has label mergepilot:paused', async () => {
    const client: Partial<GitHubClient> = {};
    const paused = await isPrPaused(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      labels: ['bug', 'mergepilot:paused'],
    });
    expect(paused).toBe(true);
  });

  it('returns true when hidden marker indicates paused', async () => {
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [
          {
            id: 1,
            body: 'Reviews paused.<!-- mergepilot:state paused -->',
            user: { login: publisherLogin },
          },
        ];
      },
    };
    const paused = await isPrPaused(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      labels: [],
    });
    expect(paused).toBe(true);
  });

  it('returns false when last marker is active', async () => {
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [
          {
            id: 1,
            body: 'Reviews paused.<!-- mergepilot:state paused -->',
            user: { login: publisherLogin },
          },
          {
            id: 2,
            body: 'Reviews resumed.<!-- mergepilot:state active -->',
            user: { login: publisherLogin },
          },
        ];
      },
    };
    const paused = await isPrPaused(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      labels: [],
    });
    expect(paused).toBe(false);
  });

  it('returns false when no label and no pause marker exist', async () => {
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [];
      },
    };
    const paused = await isPrPaused(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      labels: [],
    });
    expect(paused).toBe(false);
  });
});

describe('postPauseNoticeOnce', () => {
  const publisherLogin = 'github-actions[bot]';

  it('posts notice when not already posted and returns true', async () => {
    const createdComments: Array<{ body: string }> = [];
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [];
      },
      async createIssueComment({ body }) {
        createdComments.push({ body });
        return { id: 99 };
      },
    };

    const posted = await postPauseNoticeOnce(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      language: 'en',
    });

    expect(posted).toBe(true);
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0]?.body).toContain('Automatic reviews are paused');
    expect(createdComments[0]?.body).toContain('<!-- mergepilot:pause-notice -->');
  });

  it('does not post notice when pause-notice marker already exists', async () => {
    const createComment = vi.fn();
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [
          {
            id: 1,
            body: 'Notice: reviews skipped<!-- mergepilot:pause-notice -->',
            user: { login: publisherLogin },
          },
        ];
      },
      createIssueComment: createComment,
    };

    const posted = await postPauseNoticeOnce(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      language: 'en',
    });

    expect(posted).toBe(false);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('posts the notice again for a new pause after an earlier pause was resumed', async () => {
    const createComment = vi.fn(async () => ({ id: 9 }));
    const comments = [
      { id: 1, body: 'paused <!-- mergepilot:state paused -->', user: { login: publisherLogin } },
      { id: 2, body: 'skipped <!-- mergepilot:pause-notice -->', user: { login: publisherLogin } },
      { id: 3, body: 'resumed <!-- mergepilot:state active -->', user: { login: publisherLogin } },
      { id: 4, body: 'paused <!-- mergepilot:state paused -->', user: { login: publisherLogin } },
    ];
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return comments;
      },
      createIssueComment: createComment,
    };
    const params = { owner: 'acme', repo: 'repo', pull_number: 1, publisherLogin, language: 'en' as const };

    expect(await postPauseNoticeOnce(client as GitHubClient, params)).toBe(true);
    expect(createComment).toHaveBeenCalledTimes(1);

    comments.push({ id: 5, body: 'skipped <!-- mergepilot:pause-notice -->', user: { login: publisherLogin } });
    expect(await postPauseNoticeOnce(client as GitHubClient, params)).toBe(false);
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('posts Arabic notice when language is ar', async () => {
    const createdComments: Array<{ body: string }> = [];
    const client: Partial<GitHubClient> = {
      async listIssueCommentsPage() {
        return [];
      },
      async createIssueComment({ body }) {
        createdComments.push({ body });
        return { id: 99 };
      },
    };

    await postPauseNoticeOnce(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
      language: 'ar',
    });

    expect(createdComments[0]?.body).toContain('المراجعات التلقائية متوقفة مؤقتًا');
    expect(createdComments[0]?.body).toContain('dir="rtl"');
  });
});

describe('executePauseCommand', () => {
  const publisherLogin = 'github-actions[bot]';

  it('pauses PR: adds label and posts confirmation comment with state marker', async () => {
    const labelsAdded: string[][] = [];
    const createdComments: string[] = [];

    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'write' };
      },
      async addLabels({ labels }) {
        labelsAdded.push(labels);
      },
      async createIssueComment({ body }) {
        createdComments.push(body);
        return { id: 1 };
      },
    };

    const result = await executePauseCommand(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      command: 'pause',
      username: 'dev',
      publisherLogin,
      language: 'en',
    });

    expect(result).toEqual({ success: true, state: 'paused' });
    expect(labelsAdded).toEqual([['mergepilot:paused']]);
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0]).toContain('<!-- mergepilot:state paused -->');
  });

  it('resumes PR: removes label and posts confirmation comment with state marker', async () => {
    const labelsRemoved: string[] = [];
    const createdComments: string[] = [];

    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'write' };
      },
      async removeLabel({ name }) {
        labelsRemoved.push(name);
      },
      async createIssueComment({ body }) {
        createdComments.push(body);
        return { id: 2 };
      },
    };

    const result = await executePauseCommand(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      command: 'resume',
      username: 'dev',
      publisherLogin,
      language: 'en',
    });

    expect(result).toEqual({ success: true, state: 'active' });
    expect(labelsRemoved).toEqual(['mergepilot:paused']);
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0]).toContain('<!-- mergepilot:state active -->');
  });

  it('rejects unauthorized user and posts rejection comment', async () => {
    const addLabels = vi.fn();
    const createdComments: string[] = [];

    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'read' };
      },
      addLabels,
      async createIssueComment({ body }) {
        createdComments.push(body);
        return { id: 3 };
      },
    };

    const result = await executePauseCommand(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      command: 'pause',
      username: 'random-contributor',
      publisherLogin,
      language: 'en',
    });

    expect(result.success).toBe(false);
    expect(addLabels).not.toHaveBeenCalled();
    expect(createdComments[0]).toContain('write access');
  });
});
