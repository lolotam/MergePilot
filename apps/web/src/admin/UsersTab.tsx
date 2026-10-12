import { useMemo, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import type { AdminUser } from '../api/admin.js';
import { useMeQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.js';
import { formatDateTime } from './format.js';
import { useAdminDeleteUserMutation, useAdminUsersQuery } from './hooks.js';
import { Badge, Pager, StateMessage, TableCard, tbodyClass, tdClass, thClass, theadClass } from './ui.js';

function matches(user: AdminUser, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
}

export function UsersTab() {
  const { t, language } = useI18n();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<AdminUser | null>(null);
  const { data, isLoading, isError } = useAdminUsersQuery(offset);
  const { data: me } = useMeQuery();
  const remove = useAdminDeleteUserMutation();

  const users = useMemo(() => (data?.users ?? []).filter((u) => matches(u, search)), [data, search]);
  const roleLabel = (role: string) =>
    role === 'owner' ? t('roleOwner') : role === 'admin' ? t('roleAdmin') : t('roleMember');

  const toolbar = (
    <label className="relative flex-1 min-w-[200px] max-w-md">
      <span className="sr-only">{t('searchUsersPlaceholder')}</span>
      <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-gray-400 pointer-events-none" />
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('searchUsersPlaceholder')}
        className="w-full ps-9 pe-3 py-2 text-sm rounded-md border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-950 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      />
    </label>
  );

  let body;
  if (isLoading) body = <StateMessage>{t('loading')}</StateMessage>;
  else if (isError) body = <StateMessage>{t('adminLoadError')}</StateMessage>;
  else if (users.length === 0) body = <StateMessage>{t('noUsersFound')}</StateMessage>;
  else {
    body = (
      <table className="w-full text-start text-sm">
        <thead className={theadClass}>
          <tr>
            <th className={thClass}>{t('colUser')}</th>
            <th className={thClass}>{t('colVerified')}</th>
            <th className={thClass}>{t('colProviders')}</th>
            <th className={thClass}>{t('colWorkspaces')}</th>
            <th className={thClass}>{t('colLastSession')}</th>
            <th className={thClass}>{t('colCreated')}</th>
            <th className={thClass}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {users.map((user) => {
            const isSelf = user.id === me?.user.id;
            return (
              <tr key={user.id} className="hover:bg-gray-50/50 dark:hover:bg-ink-800/40">
                <td className={tdClass}>
                  <div className="flex items-center gap-3 min-w-[200px]">
                    {user.image ? (
                      <img src={user.image} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 flex items-center justify-center text-xs font-bold shrink-0">
                        {user.name.charAt(0).toUpperCase() || '?'}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-medium truncate">{user.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate" dir="ltr">
                        {user.email}
                      </p>
                    </div>
                  </div>
                </td>
                <td className={tdClass}>
                  <Badge tone={user.emailVerified ? 'success' : 'warning'}>
                    {user.emailVerified ? t('verified') : t('unverified')}
                  </Badge>
                </td>
                <td className={tdClass}>
                  <div className="flex flex-wrap gap-1">
                    {user.signInProviders.map((p) => (
                      <Badge key={p} tone="brand">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className={tdClass}>
                  <ul className="flex flex-col gap-0.5 min-w-[160px]">
                    {user.workspaces.length === 0 && <li className="text-gray-400">—</li>}
                    {user.workspaces.map((ws) => (
                      <li key={ws.id} className="text-xs">
                        <span className="font-medium">{ws.name}</span>
                        <span className="text-gray-500 dark:text-gray-400"> · {roleLabel(ws.role)}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={`${tdClass} text-xs whitespace-nowrap text-gray-500 dark:text-gray-400`}>
                  {formatDateTime(user.lastSessionAt, language)}
                </td>
                <td className={`${tdClass} text-xs whitespace-nowrap text-gray-500 dark:text-gray-400`}>
                  {formatDateTime(user.createdAt, language)}
                </td>
                <td className={`${tdClass} text-end`}>
                  <button
                    type="button"
                    onClick={() => setPending(user)}
                    disabled={isSelf}
                    title={isSelf ? t('cannotDeleteSelf') : t('deleteUser')}
                    aria-label={`${t('deleteUser')}: ${user.name}`}
                    className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <>
      <TableCard toolbar={toolbar} footer={<Pager page={data} onChange={setOffset} />}>
        {body}
      </TableCard>
      <ConfirmDeleteDialog
        isOpen={pending !== null}
        title={t('deleteUserConfirmTitle')}
        description={pending ? `${pending.name} (${pending.email}) — ${t('deleteUserConfirmDesc')}` : ''}
        confirmLabel={t('deleteUser')}
        isPending={remove.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          remove.mutate(pending.id, { onSettled: () => setPending(null) });
        }}
      />
    </>
  );
}
