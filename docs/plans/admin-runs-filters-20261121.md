# Admin Review Runs filters and session isolation

## 1. Goal and non-goals

Tier Heavy because platform authorization and session isolation are involved. Extend the first toolbar in the platform dashboard with User and Repo searches alongside Workspace. Follow the request from SQL through the HTTP response and the rendered page. Keep the member-facing workspace Runs page, release settings and permissions outside this change. No migration, new dependency or installation. This is an implementation plan for the checkout at 0088ad8.

## 2. Findings at 0088ad8

- `apps/app/src/db/schema.ts:188` defines a run with an opaque workspace ID and repository full name. There is no initiating user relation here. `apps/app/src/auth/schema.ts:3,54,63` defines user, organization and member. A member links organizationId and userId. `apps/app/src/admin/queries-users.ts:32` searches name OR email. `apps/app/src/admin/queries-workspaces.ts:64,110` collects workspace owner email separately and picks one owner for display.
- `apps/app/src/admin/queries.ts:43,127–168` escapes backslash, percent and underscore, shares one filter across count and data queries, LEFT JOINs organization by primary key in both, and sorts by createdAt and id descending. No duplicate-count defect in the current join. A run without an organization can still appear with a null workspaceName. Two parallel SELECTs do not promise snapshot isolation during concurrent writes.
- `apps/app/src/admin/routes.ts:56–63,83,100` trims terms, catches invalid inputs as undefined, clamps pagination and runs the platform guard before the handler. `apps/app/src/admin/guard.ts:17,44–64` requires a current session, verified email and membership in the configured normalized email list. Anonymous and ordinary sessions use callNotFound(). `apps/app/src/api/routes.ts:120` derives /api/me's flag from the same predicate.
- `apps/web/src/api/admin.ts:80,90,129` serializes with URLSearchParams. `apps/web/src/admin/hooks.ts:8–18,41` uses 300 ms debounce and keys the existing Runs inputs correctly. `apps/web/src/admin/RunsTab.tsx:21–40` already resets offset on workspace edits. Its noRunsFound message says “No review runs recorded yet.” even when a search excluded existing records (`apps/web/src/i18n/en.ts:325`).
- `apps/web/src/admin/ui.tsx:20,97,138` provides a wrapping toolbar, separate footer and labelled search inputs. `apps/web/src/App.tsx:48,66` mounts the admin page. `apps/web/src/admin/AdminPage.tsx:12–37` gates every panel on the server-derived flag, while `apps/web/src/components/Layout.tsx:257` gates the avatar link. No menu or direct-route bypass found in these checks.
- **Logout gap.** `apps/web/src/components/Layout.tsx:62–68` navigates in finally without clearing the app-level QueryClient (`apps/web/src/App.tsx:27`). Both admin data and `['me']` survive SPA navigation. `apps/web/src/api/hooks.ts:8–13` considers me fresh for ten seconds. This can expose prior-session UI/data. Server requests still require the guard. This finding comes from source inspection.
- `apps/app/src/admin/routes.test.ts:25,143` has real signed sessions and cross-workspace reads. `apps/app/src/admin/routes-search.test.ts:15–72` exercises workspace and Users searches over PGlite. `apps/app/src/admin/admin.fixtures.ts:28,161,203,257` explicitly applies migrations and seeds the regular user as owner of **both** workspaces. `apps/web/src/admin/AdminPage.test.tsx:49,139` mocks me and adminApi; `apps/web/src/admin/admin-test-utils.tsx:107` supplies sample run data. Mocking adminApi alone misses serialization errors.

## 3. Decisions

All active filters intersect. `workspaceId` is exact, `workspaceQuery` searches organization name, `user` matches a current member's name OR email (any role), and `repo` searches the stored owner/repository full name. The three text searches use case-insensitive literal substrings. Trim, ignore blanks and ignore terms over 200 after trim, per the existing search contract. Interpret User as workspace membership. A workspace can have multiple members, and ownership cannot establish who triggered a run. Keep the six columns and existing JSON response. No email leaves the query as a result field. No migration or index is justified by available measurements; a standard B-tree would not accelerate a leading wildcard. A correlated EXISTS keeps both page queries bounded in number and avoids duplicate rows. An orphan row can match repo, workspaceId or an unfiltered request, and cannot match a current organization name or member. Server guard owns authorization. Hooks and SQL execute behind their existing guarded entry points. Do not accept a client-supplied admin flag.

## 4. Implementation in dependency order

### 4.1 apps/app/src/admin/queries.ts

In the drizzle-orm import add `exists,` after `eq,` and `or,` after `isNull,`. Immediately after `workspaceQuery?: string | undefined;` inside getRuns add:

```ts
    user?: string | undefined;
    repo?: string | undefined;
```

Between the existing workspaceQuery condition and `const filter =` insert:

```ts
  if (options.user) {
    const member = authSchema.member;
    const user = authSchema.user;
    const pattern = containsPattern(options.user);
    conditions.push(exists(
      db.select({ id: member.id }).from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(
          eq(member.organizationId, org.id),
          or(ilike(user.name, pattern), ilike(user.email, pattern)),
        )),
    ));
  }
  if (options.repo) conditions.push(ilike(runs.repoFullName, containsPattern(options.repo)));
```

Keep both outer left joins, the single `filter`, both `.where(filter)` calls, projection, count, order, limit and offset.

### 4.2 apps/app/src/admin/routes.ts

Immediately after `workspaceQuery: SearchTermSchema,` add `user: SearchTermSchema,` and `repo: SearchTermSchema,` on separate lines. In getRuns's argument immediately after `workspaceQuery: query.workspaceQuery,` add `user: query.user,` and `repo: query.repo,`. Keep the preHandler. Do not log search terms. The existing request completion logger strips the query at `apps/app/src/server/create-server.ts:99`.

### 4.3 apps/web/src/api/admin.ts

After `workspaceQuery?: string;` add `user?: string;` and `repo?: string;` to AdminPageParams. Immediately after the workspaceQuery setter in withQuery add:

```ts
  if (params?.user) search.set('user', params.user);
  if (params?.repo) search.set('repo', params.repo);
```

Keep getRuns, fetchApi, AdminRun and AdminRunsResponse signatures otherwise intact.

### 4.4 apps/web/src/admin/hooks.ts

Replace just useAdminRunsQuery:

```ts
export function useAdminRunsQuery(offset: number, workspaceQuery: string, user: string, repo: string) {
  return useQuery({
    queryKey: ['admin', 'runs', offset, workspaceQuery, user, repo],
    queryFn: () => adminApi.getRuns({
      limit: ADMIN_PAGE_SIZE,
      offset,
      ...(workspaceQuery ? { workspaceQuery } : {}),
      ...(user ? { user } : {}),
      ...(repo ? { repo } : {}),
    }),
    placeholderData: keepPreviousData,
  });
}
```

### 4.5 apps/web/src/admin/RunsTab.tsx

After the workspaceSearch state declaration, replace through the end of `const toolbar` with:

```tsx
  const [userSearch, setUserSearch] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const workspaceQuery = useDebouncedValue(workspaceSearch.trim());
  const user = useDebouncedValue(userSearch.trim());
  const repo = useDebouncedValue(repoSearch.trim());
  const { data, isLoading, isError } = useAdminRunsQuery(offset, workspaceQuery, user, repo);
  const runs = data?.runs ?? [];

  const toolbar = (
    <>
      <SearchInput value={workspaceSearch} placeholder={t('filterWorkspace')}
        onChange={(value) => { setWorkspaceSearch(value); setOffset(0); }} />
      <SearchInput value={userSearch} placeholder={t('filterRunUser')}
        onChange={(value) => { setUserSearch(value); setOffset(0); }} />
      <SearchInput value={repoSearch} placeholder={t('filterRunRepo')}
        onChange={(value) => { setRepoSearch(value); setOffset(0); }} />
    </>
  );
```

Replace the one-line zero-runs branch, retaining the following else/table branch:

```tsx
  else if (runs.length === 0) {
    body = <StateMessage>{t(workspaceQuery || user || repo ? 'noMatchingAdminRuns' : 'noRunsFound')}</StateMessage>;
  }
```

Three sibling labels share the existing first toolbar on desktop and can wrap on narrow screens. The shared Pager stays in the footer.

### 4.6 apps/web/src/i18n/admin-en.ts and admin-ar.ts

Insert immediately after filterWorkspace in each dictionary, respectively:

```ts
  filterRunUser: 'Filter by member name or email...',
  filterRunRepo: 'Filter by repository...',
  noMatchingAdminRuns: 'No review runs match these filters.',
```
```ts
  filterRunUser: 'ابحث باسم العضو أو بريده الإلكتروني...',
  filterRunRepo: 'ابحث باسم المستودع...',
  noMatchingAdminRuns: 'مفيش مراجعات بتطابق الفلاتر دي.',
```

### 4.7 apps/web/src/components/Layout.tsx

Add `import { useQueryClient } from '@tanstack/react-query';` beside the React import. After `const navigate = useNavigate();` insert `const queryClient = useQueryClient();`. In handleSignOut put `queryClient.clear();` immediately before `navigate('/login');` inside finally. Clear the client that the app actually mounted, including cached identity, filter keys, results and mutations. Preserve existing sign-out invocation and navigation behavior. This fix covers explicit logout in the current tab.

### 4.8 Tests

Apply the inserts and replacements below after production changes. Use each suite's existing setup/teardown unless specified. Keep unrelated cases intact.

## 5. Test plan and mutation checks

### Route/search and DB

In `apps/app/src/admin/routes-search.test.ts` import `{ eq } from 'drizzle-orm'`, `* as authSchema from '../auth/schema.js'` and `{ reviewRuns } from '../db/schema.js'`. Insert the following inside `describe('admin API server-side search'...)` after its existing tests. Each case gets its own seeded DB. Request parameters go through a real URL, guard, schema, DB and response.

```ts
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
```

In `apps/app/src/admin/routes.test.ts` before the existing GET runs test insert:

```ts
  it('returns 404 for a workspace owner searching platform runs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/runs?repo=acme',
      headers: { cookie: regularCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('runs');
  });

  it('returns 404 for anonymous requests to platform runs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/runs?user=regular' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('runs');
  });
```

### Web client, toolbar and authorization

Create `apps/web/src/api/admin-runs.test.ts` with:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { adminApi } from './admin.js';

afterEach(() => { vi.unstubAllGlobals(); });

it('sends all run filters as URL-encoded query parameters', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ runs: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const params = { user: 'a+b@example.test', repo: 'acme/50%_off', workspaceId: 'w',
    workspaceQuery: 'A & B', limit: 50, offset: 0 };
  await adminApi.getRuns(params);
  const [path, init] = fetchMock.mock.calls[0]!;
  const url = new URL(String(path), 'http://localhost');
  expect(url.pathname).toBe('/api/admin/runs');
  expect(Object.fromEntries(url.searchParams)).toEqual({ ...params, limit: '50', offset: '0' });
  expect(init?.credentials).toBe('include');
});
```

In `apps/web/src/admin/AdminPage.test.tsx` extend `redirects non-admins to / without calling the admin API` after the home assertion:

```tsx
    expect(screen.queryByRole('tab', { name: 'Review Runs' })).toBeNull();
    expect(adminApi.getRuns).not.toHaveBeenCalled();
```

Add fireEvent to the existing @testing-library/react import. After the existing workspace filter test, insert the cases below. Keep `hooks.test.tsx`'s fake-timer test for the precise debounce boundary. The UI tests use a single paste per change; no sleeps.

```tsx
  it('debounces member and repository edits before querying', async () => {
    mockMe(true);
    const actor = userEvent.setup();
    renderWithProviders(<AdminPage />);
    await actor.click(screen.getByRole('tab', { name: 'Review Runs' }));
    await screen.findByText('acme/backend');
    const member = screen.getByPlaceholderText('Filter by member name or email...');
    const repo = screen.getByPlaceholderText('Filter by repository...');
    vi.mocked(adminApi.getRuns).mockClear();
    fireEvent.change(member, { target: { value: 'first' } });
    fireEvent.change(member, { target: { value: 'final' } });
    fireEvent.change(repo, { target: { value: 'acme' } });
    expect(adminApi.getRuns).not.toHaveBeenCalled();
    await waitFor(() => expect(adminApi.getRuns).toHaveBeenLastCalledWith({
      limit: 50, offset: 0, user: 'final', repo: 'acme',
    }));
    expect(vi.mocked(adminApi.getRuns).mock.calls.some(([p]) => p?.user === 'first')).toBe(false);
  });

  it('places member and repo filters in the first toolbar and combines their requests', async () => {
    mockMe(true);
    const actor = userEvent.setup();
    renderWithProviders(<AdminPage />);
    await actor.click(screen.getByRole('tab', { name: 'Review Runs' }));
    const table = (await screen.findByText('acme/backend')).closest('table')!;
    const toolbar = table.parentElement!.previousElementSibling as HTMLElement;
    const fields = within(toolbar).getAllByRole('searchbox');
    expect(fields.map((field) => field.getAttribute('placeholder'))).toEqual([
      'Filter by workspace name...', 'Filter by member name or email...', 'Filter by repository...',
    ]);
    await actor.click(fields[1]!);
    await actor.paste(' Sara ');
    await waitFor(() => expect(adminApi.getRuns).toHaveBeenLastCalledWith({
      limit: 50, offset: 0, user: 'Sara',
    }));
    vi.mocked(adminApi.getRuns).mockResolvedValue({ ...runsFixture, total: 0, runs: [] });
    await actor.click(fields[2]!);
    await actor.paste(' other/app ');
    expect(await screen.findByText('No review runs match these filters.')).toBeTruthy();
    expect(screen.queryByText('acme/backend')).toBeNull();
    expect(adminApi.getRuns).toHaveBeenLastCalledWith({
      limit: 50, offset: 0, user: 'Sara', repo: 'other/app',
    });
  });

  it.each([
    ['Filter by member name or email...', 'user'],
    ['Filter by repository...', 'repo'],
  ])('resets page two when editing %s', async (label, key) => {
    mockMe(true);
    vi.mocked(adminApi.getRuns).mockImplementation(async (params) => ({
      ...runsFixture, total: 51, offset: params?.offset ?? 0,
    }));
    const actor = userEvent.setup();
    renderWithProviders(<AdminPage />);
    await actor.click(screen.getByRole('tab', { name: 'Review Runs' }));
    await actor.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(adminApi.getRuns).toHaveBeenLastCalledWith({ limit: 50, offset: 50 }));
    await actor.click(screen.getByPlaceholderText(label));
    await actor.paste('sample');
    await waitFor(() => expect(adminApi.getRuns).toHaveBeenLastCalledWith({
      limit: 50, offset: 0, [key]: 'sample',
    }));
  });
```

### Logout regression

In `apps/web/src/components/Layout.test.tsx` import `{ QueryClient, QueryClientProvider } from '@tanstack/react-query'` and `{ authClient } from '../auth/client.js'`. Add `client = new QueryClient()` as the third default parameter of renderLayout. Wrap its existing I18nProvider subtree in `<QueryClientProvider client={client}>…</QueryClientProvider>`. Inside Routes before the parent Layout route add `<Route path="/login" element={<p>Login destination</p>} />`. AdminNavLink tests already use a real QueryClientProvider. Add after renderLayout:

```tsx
  it('clears prior admin results and identity on sign out before the next login', async () => {
    mockMe(true);
    const client = new QueryClient();
    const key = ['admin', 'runs', 0, '', 'member', 'repo'];
    client.setQueryData(key, { total: 1, runs: [{ id: 'private-run' }] });
    client.setQueryData(['me'], { isPlatformAdmin: true });
    renderLayout('/admin', 'en', client);
    expect(client.getQueryData(key)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Signed in as' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByText('Login destination')).toBeTruthy();
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(['me'])).toBeUndefined();
  });
```

### Mutation checks

Check each row by reasoning through the named assertion, or temporarily mutate then revert just that edit before the final gates.

| Mutation | Expected failing assertion |
| --- | --- |
| Drop guard | anonymous/owner 404 |
| Search owners only, omit email or omit name | analyst member name/email cases |
| Join members in the outer result | page total or unique ids |
| Use wildcard term without escaping | literal percent/underscore result set |
| Apply only the last filter | conflicting workspaceId/workspaceQuery or repo returns rows |
| Move filter to list only | filtered total |
| Change LEFT JOIN to INNER JOIN | missing organization row |
| Omit serialized repo/user or either query-key element | URL round-trip or UI refetch |
| Drop either offset reset | matching page-two case |
| Remove debounce | existing timer test for helper; additionally verify RunsTab passes debounced values to the hook |
| Remove clear or clear just the admin prefix | cached run or cached me survives |
| Render panel before me check | non-admin redirect/tab/API assertions |

## 6. Gates in order

Use PowerShell in the assigned worktree, Node >=22.19.0 and pnpm 12.11.2 (`package.json:5–16`). Dependencies are installed. Stop on any nonzero exit, fix the cause and repeat that gate. These commands are for implementation verification, not for the design-only assignment.

```powershell
pnpm typecheck
pnpm lint
pnpm exec vitest run apps/app/src/admin/routes-search.test.ts apps/app/src/admin/routes.test.ts apps/app/src/admin/guard.test.ts apps/app/src/admin/me.test.ts
pnpm exec vitest run apps/web/src/admin/AdminPage.test.tsx apps/web/src/admin/AdminNavLink.test.tsx apps/web/src/admin/hooks.test.tsx apps/web/src/components/Layout.test.tsx apps/web/src/api/admin-runs.test.ts apps/web/src/i18n/i18n.test.ts
pnpm test
pnpm build
git diff --check
git status --short
```

The routes suites above are DB-backed unit tests using embedded PGlite and real auth sessions. Require actual passing results for both route files. The full pnpm test also runs the DB suites. pnpm test:integration uses a separate config and cannot substitute for the DB-backed unit tests. Record command outcomes and any skipped verification.

## 7. Pitfalls

- Use a CRLF-preserving UTF-8 editor or a Node patch script that reads UTF-8, matches anchors once, preserves line endings and writes UTF-8 without BOM. Check `git ls-files --eol` and the diff. Avoid writing Arabic with an ANSI/default PowerShell encoding.
- ESLint limits code files to 400 lines excluding comments and blank lines (`eslint.config.js:12`). Keep unrelated test setup in place. All relative TypeScript imports use .js extensions.
- The admin fixture applies a hard-coded migration list through 0021_main_bot_active.sql. No schema change in this task; leave migrations, fixture migration list and production settings alone.
- Never commit or push under this assignment. Stay inside the assigned worktree. Do not install dependencies, copy from reference/, change CI, expose raw SQL inputs or include real emails, sessions, credentials or secret values in logs/test output.
- URL encoding protects transport syntax; containsPattern handles LIKE semantics. Both are required. A filter with 201 trimmed characters deliberately drops out server-side. A workspace owner also requires platform authorization for this endpoint.
- Keep previous pages within the current login only. Clearing only admin query data leaves a fresh me entry. Adding useQueryClient requires mounting a QueryClientProvider in **every** isolated Layout test harness.

## 8. Review checklist

- **clean-code-guard** — Inspect the exact diff. Reuse containsPattern, SearchTermSchema, SearchInput, TableCard, Pager and the existing guard. Verify parameter names through every layer, and inspect both outer queries for the same predicate. No per-run member lookups.
- **test-guard** — Verify real PGlite/auth and signed cookies for route behavior, a direct client URL assertion for transport, a real QueryClient for logout, page two before offset reset and exact result sets for multi-match filters. Keep the prior workspace search and deleted-workspace behavior. Confirm the mutation checks above would detect regressions.
- **docs-guard** — Compare Arabic usage copy to actual navigation, labels, member semantics, field caps and 404 behavior. Keep historical decisions and the workspace's separate Runs docs intact.
- **security-review** — Trace anonymous, ordinary verified workspace owner and allowlisted verified platform operator through the same route. Confirm /api/me and the server guard share the predicate. Review query binding, literal wildcards, log fields, minimal response shape and removal of cached identity/results upon logout. No client-controlled identity can authorize a query.

## 9. Documentation edits for implementation

`docs/usage.ar.md:353` begins the platform-only Website Scan section. There is no equivalent operator Runs search guide there. Immediately before `## فحص المواقع`, insert the following subsection and divider. The docs search also covered architecture, deploy, ADRs and historical plans; the operator procedure belongs in the usage guide. The design assignment creates only this plan.

```md
## البحث في مراجعات المنصة

من قائمة حسابك افتح «إدارة المنصة»، وبعدها تبويب «المراجعات». التبويب ده متاح بس لمدير منصة بريده الإلكتروني متأكد منه وموجود في قائمة مديري المنصة. أي مستخدم تاني أو زائر بيجيله 404 لو طلب `GET /api/admin/runs`.

تقدر تجمع بين اسم مساحة العمل، واسم أي عضو حالي فيها أو بريده الإلكتروني، واسم المستودع الكامل على GitHub زي `acme/backend`. البحث بيقبل جزء من الاسم أو البريد من غير تفرقة بين الحروف الكبيرة والصغيرة. فلتر العضو بيجيب مراجعات مساحات العمل اللي هو عضو فيها، حتى لو المراجعة شغّلها حد تاني. كل ما تغيّر فلتر، النتائج بترجع لأول صفحة.

---
```

## 10. Open questions

None blocking. The selected interpretation is current membership, including non-owner members. The plan requests no run-actor attribution or extra PII column.

