import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { executePauseCommand } from './pause.js';

describe('executePauseCommand — resume when the label cannot be removed', () => {
  const resumeWith = async (removeError: unknown) => {
    const replies: string[] = [];
    const client: Partial<GitHubClient> = {
      async getCollaboratorPermission() {
        return { permission: 'write' };
      },
      async removeLabel() {
        throw removeError;
      },
      async createIssueComment({ body }) {
        replies.push(body);
        return { id: replies.length };
      },
    };
    const result = await executePauseCommand(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      command: 'resume',
      username: 'alice',
      publisherLogin: 'mergepilot[bot]',
      language: 'en',
    });
    return { result, replies };
  };

  it('treats a 404 (label already absent) as resumed', async () => {
    const { result, replies } = await resumeWith(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(result).toEqual({ success: true, state: 'active' });
    expect(replies[0]).toContain('<!-- mergepilot:state active -->');
  });

  it('reports a failure and does not claim "resumed" on any other error', async () => {
    const { result, replies } = await resumeWith(Object.assign(new Error('Forbidden'), { status: 403 }));
    expect(result).toEqual({ success: false, reason: 'label_error' });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Could not remove');
    expect(replies[0]).not.toContain('mergepilot:state');
  });
});
