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
  void client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
  await client.cancelQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
  void client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
}
