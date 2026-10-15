import type { KeyRoster, KeyRotationEvent, Secret } from '@mergepilot/engine';
import type { Logger } from 'pino';
import { isMultiKeyProvider, MAX_PROVIDER_KEYS } from '../credentials/multi-key.js';
import type { ProcessReviewCredentials } from './types.js';

/** What a finished run records: which key answered, and how many were skipped. Never the key. */
export interface KeyRotationDisclosure {
  provider: string;
  keyIndex: number;
  skipped: number;
}

/** Loads one roster per multi-key provider. Missing method, other providers, and empty lists are skipped. */
export async function loadRosters(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  providers: readonly string[],
  primaryProvider: string,
  logger: Logger,
  keyIdsByProvider: Record<string, string[]>,
): Promise<Record<string, KeyRoster>> {
  const rosters: Record<string, KeyRoster> = {};
  if (!credentials.resolveKeyRoster) return rosters;
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider) || !isMultiKeyProvider(provider)) continue;
    seen.add(provider);
    try {
      const roster = await credentials.resolveKeyRoster(workspaceId, provider);
      if (!roster || roster.secrets.length === 0) continue;
      keyIdsByProvider[provider] = roster.keyIds;
      rosters[provider] = { keys: roster.secrets, startIndex: roster.startIndex };
    } catch (error) {
      if (provider === primaryProvider) throw error;
      logger.warn(
        {
          event: 'credential.key_roster_failed',
          provider,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Could not load the API key roster for a provider',
      );
    }
  }
  return rosters;
}

export function rosterSecrets(rosters: Readonly<Record<string, KeyRoster>>): Secret[] {
  return Object.values(rosters).flatMap((roster) => [...roster.keys]);
}

/**
 * Records a successful rotation and stores the index. A cursor write that fails is logged and
 * does not fail the review. The log line carries the index and the skip count only.
 */
export function rotationHandler(
  events: KeyRotationDisclosure[],
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  logger: Logger,
  keyIdsByProvider: Readonly<Record<string, readonly string[]>>,
): (event: KeyRotationEvent) => void {
  return (event) => {
    if (events.length < MAX_PROVIDER_KEYS) {
      events.push({ provider: event.provider, keyIndex: event.index, skipped: event.skipped });
    }
    logger.info(
      { event: 'credential.key_rotation', provider: event.provider, keyIndex: event.index, skipped: event.skipped },
      `API key ${event.index} answered after skipping ${event.skipped}`,
    );
    if (!credentials.rememberSuccessfulKey || !isMultiKeyProvider(event.provider)) return;
    const provider = event.provider;
    const keyId = keyIdsByProvider[provider]?.[event.index];
    if (!keyId) return;
    void Promise.resolve(credentials.rememberSuccessfulKey(workspaceId, provider, keyId)).catch((error: unknown) => {
      logger.warn(
        {
          event: 'credential.key_cursor_failed',
          provider,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Could not store the last successful API key index',
      );
    });
  };
}
