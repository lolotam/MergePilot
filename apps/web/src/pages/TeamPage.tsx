import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router';
import { Users, UserPlus, Mail, Shield, Trash2, X, Clock } from 'lucide-react';
import { useMeQuery } from '../api/hooks.js';
import { authClient } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useToast } from '../components/Toast.js';
import { PageHeader } from '../components/PageHeader.js';

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
    <div className="flex flex-col gap-6 max-w-5xl">
      <PageHeader
        title={t('teamTitle')}
        subtitle={t('teamDesc')}
      />

      {/* Invite Member Section */}
      {canManageTeam && (
        <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
              <UserPlus className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
              {t('inviteMemberTitle')}
            </h2>
          </div>

          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 w-full">
              <label htmlFor="invite-email" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                {t('inviteEmailLabel')}
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t('inviteEmailPlaceholder')}
                className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
              />
            </div>

            <div className="w-full sm:w-40">
              <label htmlFor="invite-role" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                {t('inviteRoleLabel')}
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
              >
                <option value="admin">{t('roleAdmin')}</option>
                <option value="member">{t('roleMember')}</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={isInviting || !inviteEmail.trim()}
              className="w-full sm:w-auto px-6 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full font-medium text-xs transition-colors shrink-0"
            >
              {isInviting ? t('invitingMember') : t('inviteButton')}
            </button>
          </form>
        </div>
      )}

      {/* Current Members List */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4" />
          </div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('membersListTitle')}
          </h2>
        </div>

        {loading ? (
          <div className="py-6 text-sm text-ink-400">{t('loading')}</div>
        ) : (
          <div className="divide-y divide-ink-100 dark:divide-ink-800">
            {members.map((m) => (
              <div key={m.id} className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 font-bold flex items-center justify-center text-xs shrink-0">
                    {m.user?.name ? m.user.name.charAt(0).toUpperCase() : m.user?.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-xs text-ink-900 dark:text-ink-100 truncate">{m.user?.name || m.user?.email}</p>
                    <p className="text-[11px] text-ink-500 dark:text-ink-400 truncate">{m.user?.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {canManageTeam && m.role !== 'owner' ? (
                    <select
                      value={m.role}
                      onChange={(e) => handleChangeRole(m, e.target.value as 'admin' | 'member')}
                      className="px-3 py-1 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100"
                    >
                      <option value="admin">{t('roleAdmin')}</option>
                      <option value="member">{t('roleMember')}</option>
                    </select>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-300">
                      <Shield className="w-3 h-3" />
                      <span>{m.role === 'owner' ? t('roleOwner') : m.role === 'admin' ? t('roleAdmin') : t('roleMember')}</span>
                    </span>
                  )}

                  {canManageTeam && m.role !== 'owner' && (
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(m)}
                      className="p-1.5 rounded-full text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                      aria-label={t('removeMemberButton')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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
        <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
              {t('pendingInvitesTitle')}
            </h2>
          </div>

          {loading ? (
            <div className="py-6 text-sm text-ink-400">{t('loading')}</div>
          ) : invitations.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
              {t('noPendingInvites')}
            </div>
          ) : (
            <div className="divide-y divide-ink-100 dark:divide-ink-800">
              {invitations.map((inv) => (
                <div key={inv.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Mail className="w-4 h-4 text-ink-400" />
                    <div>
                      <p className="text-xs font-semibold text-ink-900 dark:text-ink-100">{inv.email}</p>
                      <p className="text-[11px] text-ink-500 capitalize">{inv.role === 'admin' ? t('roleAdmin') : t('roleMember')}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCancelInvitation(inv.id)}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-full transition-colors border border-red-200 dark:border-red-900/60"
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
