import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n/context.js';
import { SubscriptionSignIn } from '../settings/SubscriptionSignIn.js';
import type { SubscriptionProvider } from '../api/client.js';

export function AddKeyModalDualSubscription({
  workspaceId,
  provider,
  onConnected,
}: {
  workspaceId: string;
  provider: SubscriptionProvider;
  onConnected?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const handleConnected = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
    onConnected?.();
  };
  return (
    <div className="rounded-xl border border-ink-200 dark:border-ink-800 p-3">
      <p className="text-xs font-semibold mb-2">{t('authMethodSubscription')}</p>
      <SubscriptionSignIn key={provider} workspaceId={workspaceId} provider={provider} onConnected={handleConnected} />
    </div>
  );
}
