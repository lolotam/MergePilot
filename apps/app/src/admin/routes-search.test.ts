import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import * as authSchema from '../auth/schema.js';
import { reviewRuns } from '../db/schema.js';
import { createSeededAdminApp, type AdminTestDb } from './admin.fixtures.js';
import { containsPattern } from './queries.js';

describe('containsPattern', () => {
  it('wraps the term and escapes LIKE wildcards and backslashes', () => {
    expect(containsPattern('acme')).toBe('%acme%');
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

// Seed: users "Admin User" <admin@mergepilot.com> and "Regular User" <user@example.com>;
// runs: two in ws-1 "Acme Corp", one in ws-2 "Solo Project".
describe('admin API server-side search', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let adminCookie: string;

  beforeEach(async () => {
    ({ app, handle, adminCookie } = await createSeededAdminApp());
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  async function get(url: string) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('GET /api/admin/users?q matches name or email, case-insensitively, with the filtered total', async () => {
    const byName = await get('/api/admin/users?q=regular');
    expect(byName.users.map((u: { id: string }) => u.id)).toEqual(['u-regular']);
    expect(byName.total).toBe(1);

    const byEmail = await get('/api/admin/users?q=MERGEPILOT.COM');
    expect(byEmail.users.map((u: { id: string }) => u.id)).toEqual(['u-admin']);
    expect(byEmail.total).toBe(1);

    const none = await get('/api/admin/users?q=nobody');
    expect(none.users).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('GET /api/admin/users treats wildcards literally and ignores a blank q', async () => {
    expect((await get('/api/admin/users?q=%25')).total).toBe(0);
    expect((await get('/api/admin/users?q=_')).total).toBe(0);
    expect((await get(`/api/admin/users?q=${encodeURIComponent("' OR 1=1 --")}`)).total).toBe(0);
    expect((await get('/api/admin/users?q=%20%20')).total).toBe(2);
  });

  it('GET /api/admin/runs?workspaceQuery filters by workspace name', async () => {
    const acme = await get('/api/admin/runs?workspaceQuery=acme');
    expect(acme.total).toBe(2);
    expect(acme.runs.every((r: { workspaceId: string }) => r.workspaceId === 'ws-1')).toBe(true);

    const solo = await get('/api/admin/runs?workspaceQuery=SOLO');
    expect(solo.total).toBe(1);
    expect(solo.runs[0].workspaceName).toBe('Solo Project');

    expect((await get('/api/admin/runs?workspaceQuery=zzz')).total).toBe(0);
  });

  it('GET /api/admin/runs combines workspaceId and workspaceQuery', async () => {
    expect((await get('/api/admin/runs?workspaceId=ws-1&workspaceQuery=acme')).total).toBe(2);
    expect((await get('/api/admin/runs?workspaceId=ws-1&workspaceQuery=solo')).total).toBe(0);
  });

  async function addMember() {
    await handle.db.insert(authSchema.user).values({
      id: 'extra', name: 'Regular Analyst', email: 'member%_x@example.test',
    });
    await handle.db.insert(authSchema.member).values({
      id: 'extra-member', organizationId: 'ws-1', userId: 'extra', role: 'member',
    });
  }

  async function match(params: Record<string, string>, repos: string[]) {
    const page = await get('/api/admin/runs?' + new URLSearchParams(params));
    expect(page.total).toBe(repos.length);
    expect(page.runs.map((r: { repoFullName: string }) => r.repoFullName).sort())
      .toEqual([...repos].sort());
    return page;
  }

  const acme = ['acme/backend', 'acme/frontend'];
  const all = [...acme, 'solo/app'];

  it('matches current workspace members by name or email regardless of role', async () => {
    await addMember();
    const result = await match({ user: ' aNaLYsT ' }, acme);
    await match({ user: 'X@EXAMPLE.TEST' }, acme);
    await match({ user: 'absent' }, []);
    expect(Object.keys(result.runs[0]).sort()).toEqual([
      'costUsd', 'createdAt', 'finishedAt', 'id', 'pullNumber',
      'repoFullName', 'status', 'workspaceId', 'workspaceName',
    ]);
  });

  it('matches the full repository name by case-insensitive substring', async () => {
    await match({ repo: ' ME/BaC ' }, ['acme/backend']);
    await match({ repo: 'absent' }, []);
  });

  it('intersects user, repo, workspaceQuery and workspaceId', async () => {
    await addMember();
    await match({ user: 'analyst', repo: 'END' }, acme);
    await match({ user: 'analyst', repo: 'app' }, []);
    const filters = { user: 'analyst', repo: 'back', workspaceQuery: 'cme', workspaceId: 'ws-1' };
    await match(filters, ['acme/backend']);
    await match({ ...filters, workspaceId: 'ws-2' }, []);
    await match({ ...filters, workspaceQuery: 'Solo' }, []);
  });

  it('treats percent and underscore literally in each new filter', async () => {
    await addMember();
    await handle.db.update(reviewRuns).set({ repoFullName: 'acme/50%_off' })
      .where(eq(reviewRuns.repoFullName, 'acme/backend'));
    for (const literal of ['%', '_']) {
      await match({ repo: literal }, ['acme/50%_off']);
      await match({ user: literal }, ['acme/50%_off', 'acme/frontend']);
    }
  });

  it('ignores blank and oversized terms independently after trimming', async () => {
    for (const term of ['  ', 'x'.repeat(201)]) {
      await match({ user: term }, all);
      await match({ repo: term }, all);
      await match({ user: term, repo: 'solo/' }, ['solo/app']);
    }
    await match({ repo: 'x'.repeat(200) }, []);
    await match({ user: 'x'.repeat(200) }, []);
  });

  it('counts each run once across pages with two matching members', async () => {
    await addMember();
    await match({ user: 'regular' }, all);
    const ids: string[] = [];
    for (const offset of [0, 1, 2]) {
      const page = await get('/api/admin/runs?user=regular&limit=1&offset=' + offset);
      expect(page).toMatchObject({ total: 3, limit: 1, offset });
      expect(page.runs).toHaveLength(1);
      ids.push(page.runs[0].id);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a run with a missing organization searchable by repo only or workspace id', async () => {
    await handle.db.update(reviewRuns).set({ workspaceId: 'gone' })
      .where(eq(reviewRuns.repoFullName, 'solo/app'));
    await match({}, all);
    const page = await match({ repo: 'solo/' }, ['solo/app']);
    expect(page.runs[0].workspaceName).toBeNull();
    await match({ workspaceId: 'gone' }, ['solo/app']);
    await match({ workspaceQuery: 'Solo' }, []);
    await match({ user: 'regular' }, acme);
  });
});
