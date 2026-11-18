import type { QueryClient } from '@tanstack/react-query';

const credentialEvents = new WeakMap<QueryClient, EventTarget>();

export function onCredentialChange(client: QueryClient, workspaceId: string, listener: () => void): () => void {
  const events = credentialEvents.get(client) ?? new EventTarget();
  credentialEvents.set(client, events);
  events.addEventListener(workspaceId, listener);
  return () => events.removeEventListener(workspaceId, listener);
}

/** Cancel even a first fetch with no cached data before starting a read for the new credential. */
export async function refreshCredentialQueries(client: QueryClient, workspaceId: string): Promise<void> {
  credentialEvents.get(client)?.dispatchEvent(new Event(workspaceId));
  const keys = { queryKey: ['workspaces', workspaceId, 'keys'] };
  const providers = { queryKey: ['workspaces', workspaceId, 'providers'] };
  await Promise.all([client.cancelQueries(keys), client.cancelQueries(providers)]);
  void client.invalidateQueries(keys);
  void client.invalidateQueries(providers);
}
