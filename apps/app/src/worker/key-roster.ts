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

export interface LoadedRosters {
  rosters: Record<string, KeyRoster>;
  keyIds: Record<string, string[]>;
}

/** Loads one roster per multi-key provider. Missing method, other providers, and empty lists are skipped. */
export async function loadRosters(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  providers: readonly string[],
  primaryProvider: string,
  logger: Logger,
): Promise<LoadedRosters> {
  const rosters: Record<string, KeyRoster> = {};
  const keyIds: Record<string, string[]> = {};
  if (!credentials.resolveKeyRoster) return { rosters, keyIds };
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider) || !isMultiKeyProvider(provider)) continue;
    seen.add(provider);
    try {
      const roster = await credentials.resolveKeyRoster(workspaceId, provider);
      if (!roster || roster.secrets.length === 0) continue;
      keyIds[provider] = [...roster.keyIds];
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
  return { rosters, keyIds };
}

export function rosterSecrets(rosters: Readonly<Record<string, KeyRoster>>): Secret[] {
  return Object.values(rosters).flatMap((roster) => [...roster.keys]);
}

/**
 * Cursor writes of one run, applied in order. `flush` resolves once every queued write has
 * settled, so the run completes only after the next review can read the stored key.
 */
export class CursorWrites {
  #chain: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): void {
    this.#chain = this.#chain.then(write);
  }

  flush(): Promise<void> {
    return this.#chain;
  }
}

/**
 * Records a successful rotation and queues the cursor write. A write that fails is logged and
 * does not fail the review. The log line carries the index and the skip count only.
 */
export function rotationHandler(
  events: KeyRotationDisclosure[],
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  logger: Logger,
  keyIdsByProvider: Readonly<Record<string, readonly string[]>>,
  writes: CursorWrites,
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
    const remember = credentials.rememberSuccessfulKey;
    writes.enqueue(() => Promise.resolve(remember(workspaceId, provider, keyId)).catch((error: unknown) => {
      logger.warn(
        {
          event: 'credential.key_cursor_failed',
          provider,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Could not store the last successful API key index',
      );
    }));
  };
}
