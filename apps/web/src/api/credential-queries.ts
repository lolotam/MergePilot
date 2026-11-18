import type { QueryClient } from '@tanstack/react-query';
import type { KeyProvider } from './client.js';

const credentialEvents = new WeakMap<QueryClient, EventTarget>();

export function onCredentialChange(
  client: QueryClient, workspaceId: string, listener: (providers: readonly KeyProvider[]) => void,
): () => void {
  const events = credentialEvents.get(client) ?? new EventTarget();
  credentialEvents.set(client, events);
  const onChange = (event: Event) => listener((event as CustomEvent<readonly KeyProvider[]>).detail);
  events.addEventListener(workspaceId, onChange);
  return () => events.removeEventListener(workspaceId, onChange);
}

/** Cancel even a first fetch with no cached data before starting a read for the new credential. */
export async function refreshCredentialQueries(
  client: QueryClient, workspaceId: string, changedProviders: readonly KeyProvider[], refreshWorkspace = false,
): Promise<void> {
  credentialEvents.get(client)?.dispatchEvent(new CustomEvent(workspaceId, { detail: changedProviders }));
  const keys = { queryKey: ['workspaces', workspaceId, 'keys'] };
  const providers = {
    queryKey: ['workspaces', workspaceId, 'providers'],
    predicate: (query: { queryKey: readonly unknown[] }) => changedProviders.some((provider) => provider === query.queryKey[3]),
  };
  const remaining = {
    queryKey: ['workspaces', workspaceId],
    predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] !== 'keys' && query.queryKey[2] !== 'providers',
  };
  const clearCatalogs = client.resetQueries(providers);
  await Promise.all([client.cancelQueries(keys), refreshWorkspace ? client.cancelQueries(remaining) : undefined]);
  await Promise.all([
    clearCatalogs,
    client.invalidateQueries(keys),
    refreshWorkspace ? client.invalidateQueries(remaining) : undefined,
  ]);
}
