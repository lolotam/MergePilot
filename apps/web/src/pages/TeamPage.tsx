import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router';
import { Users, UserPlus, Mail, Shield, Trash2, X, Clock } from 'lucide-react';
import { useMeQuery } from '../api/hooks.js';
import { authClient } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useToast } from '../components/Toast.js';

interface OrgMember {
  id: string;
  userId: string;
  role: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
  };
}

interface OrgInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date | string;
}

export function TeamPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();
  const { showToast } = useToast();
  const { data: meData } = useMeQuery();

  const currentWorkspace = meData?.workspaces.find((w) => w.id === workspaceId);
  const canManageTeam = currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'admin';

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite Form State
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [isInviting, setIsInviting] = useState(false);

  const loadOrgDetails = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authClient.organization.getFullOrganization({
        query: { organizationId: workspaceId },
      });
      if (res && 'data' in res && res.data) {
        const data = res.data as unknown as {
          members?: OrgMember[];
          invitations?: OrgInvitation[];
        };
        setMembers(data.members ?? []);
        setInvitations(data.invitations ?? []);
      }
    } catch {
      // Fallback or silently continue
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadOrgDetails();
  }, [loadOrgDetails]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageTeam || !inviteEmail.trim()) return;

    setIsInviting(true);
    try {
      await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
        organizationId: workspaceId,
      });
      showToast(t('inviteSentSuccess'), 'success');
      setInviteEmail('');
      await loadOrgDetails();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('error');
      showToast(msg, 'error');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (member: OrgMember) => {
    if (!canManageTeam) return;
    if (member.role === 'owner') {
      showToast(t('cannotChangeOwnerRole'), 'error');
      return;
    }
    if (window.confirm(t('removeMemberConfirm'))) {
      try {
        await authClient.organization.removeMember({
          memberIdOrEmail: member.id,
          organizationId: workspaceId,
        });
        showToast(t('success'), 'success');
        await loadOrgDetails();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('error');
        showToast(msg, 'error');
      }
    }
  };

  const handleChangeRole = async (member: OrgMember, newRole: 'admin' | 'member') => {
    if (!canManageTeam || member.role === 'owner') return;
    try {
      await authClient.organization.updateMemberRole({
        memberId: member.id,
        role: newRole,
        organizationId: workspaceId,
      });
      showToast(t('success'), 'success');
      await loadOrgDetails();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('error');
      showToast(msg, 'error');
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    if (!canManageTeam) return;
    try {
      await authClient.organization.cancelInvitation({
        invitationId,
      });
      showToast(t('success'), 'success');
      await loadOrgDetails();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('error');
      showToast(msg, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          {t('teamTitle')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('teamDesc')}</p>
      </div>

      {/* Invite Member Section (Owner & Admin only) */}
      {canManageTeam && (
        <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xs">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>{t('inviteMemberTitle')}</span>
          </h2>

          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 w-full">
              <label htmlFor="invite-email" className="block text-xs font-medium mb-1">
                {t('inviteEmailLabel')}
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t('inviteEmailPlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
              />
            </div>

            <div className="w-full sm:w-40">
              <label htmlFor="invite-role" className="block text-xs font-medium mb-1">
                {t('inviteRoleLabel')}
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
              >
                <option value="admin">{t('roleAdmin')}</option>
                <option value="member">{t('roleMember')}</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={isInviting || !inviteEmail.trim()}
              className="w-full sm:w-auto px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors shrink-0"
            >
              {isInviting ? t('invitingMember') : t('inviteButton')}
            </button>
          </form>
        </div>
      )}

      {/* Current Members List */}
      <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xs">
        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
          <Users className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <span>{t('membersListTitle')}</span>
        </h2>

        {loading ? (
          <div className="py-6 text-sm text-gray-400">{t('loading')}</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {members.map((m) => (
              <div key={m.id} className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-600 dark:text-blue-300 font-bold flex items-center justify-center text-sm shrink-0">
                    {m.user?.name ? m.user.name.charAt(0).toUpperCase() : m.user?.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{m.user?.name || m.user?.email}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{m.user?.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {canManageTeam && m.role !== 'owner' ? (
                    <select
                      value={m.role}
                      onChange={(e) => handleChangeRole(m, e.target.value as 'admin' | 'member')}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                    >
                      <option value="admin">{t('roleAdmin')}</option>
                      <option value="member">{t('roleMember')}</option>
                    </select>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      <Shield className="w-3 h-3" />
                      <span>{m.role === 'owner' ? t('roleOwner') : m.role === 'admin' ? t('roleAdmin') : t('roleMember')}</span>
                    </span>
                  )}

                  {canManageTeam && m.role !== 'owner' && (
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(m)}
                      className="p-1 rounded text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                      aria-label={t('removeMemberButton')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {canManageTeam && (
        <div className="p-6 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xs">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            <span>{t('pendingInvitesTitle')}</span>
          </h2>

          {loading ? (
            <div className="py-6 text-sm text-gray-400">{t('loading')}</div>
          ) : invitations.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
              {t('noPendingInvites')}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {invitations.map((inv) => (
                <div key={inv.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Mail className="w-4 h-4 text-gray-400" />
                    <div>
                      <p className="text-sm font-medium">{inv.email}</p>
                      <p className="text-xs text-gray-500 capitalize">{inv.role === 'admin' ? t('roleAdmin') : t('roleMember')}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCancelInvitation(inv.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>{t('cancelInviteButton')}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
