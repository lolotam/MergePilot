import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { PlusCircle } from 'lucide-react';
import { useMeQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { authClient } from '../auth/client.js';
import { useToast } from '../components/Toast.js';
import { LandingPage } from './LandingPage.js';

export function RootRedirectPage() {
  const { data: meData, isLoading, isError, refetch } = useMeQuery();
  const { t } = useI18n();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-sm text-ink-400">{t('loading')}</div>
      </div>
    );
  }

  // Signed-out visitors see the Landing Page
  if (isError || !meData?.user) {
    return <LandingPage />;
  }

  const workspaces = meData.workspaces;
  if (workspaces.length > 0) {
    return <Navigate to={`/w/${workspaces[0]!.id}`} replace />;
  }

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const generatedSlug = slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    setIsSubmitting(true);
    try {
      const res = await authClient.organization.create({
        name: name.trim(),
        slug: generatedSlug,
      });

      showToast(t('success'), 'success');
      await refetch();
      const orgId = (res as { data?: { id?: string } })?.data?.id;
      if (orgId) {
        navigate(`/w/${orgId}`);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : t('error');
      showToast(errorMsg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <PlusCircle className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-serif text-xl font-bold text-ink-900 dark:text-ink-100">{t('createWorkspaceTitle')}</h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('createWorkspaceDesc')}</p>
        </div>
      </div>

      <form onSubmit={handleCreateWorkspace} className="flex flex-col gap-4">
        <div>
          <label htmlFor="ws-name" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
            {t('workspaceNameLabel')}
          </label>
          <input
            id="ws-name"
            type="text"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slug) {
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
              }
            }}
            placeholder={t('workspaceNamePlaceholder')}
            className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-xs focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          />
        </div>

        <div>
          <label htmlFor="ws-slug" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
            {t('workspaceSlugLabel')}
          </label>
          <input
            id="ws-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={t('workspaceSlugPlaceholder')}
            className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-xs focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !name.trim()}
          className="mt-2 w-full py-2.5 px-5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full font-medium text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
        >
          {isSubmitting ? t('creatingWorkspace') : t('createWorkspaceButton')}
        </button>
      </form>
    </div>
  );
}
