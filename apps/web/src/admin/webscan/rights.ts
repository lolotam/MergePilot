import { useCallback, useMemo, useState } from 'react';
import { isPermissionLost } from './hooks.js';

/**
 * The rights of the session over the website scan area (ADR-0052 section 12).
 *
 * Every route of the area answers the regular 404 to a session that lost its
 * platform-admin rights, so a 404 is never a missing row: it is the end of
 * the access. Every failed request of the area is reported here, and the
 * panel that gets the refusal swaps its area for the permission-lost state:
 * a retry of a refused request would only be refused again.
 */
export interface WebScanRights {
  /** True when the session lost its platform-admin rights over the area. */
  lost: boolean;
  /**
   * Reports a failed request of the area.
   *
   * It returns true when the request was refused because the rights are
   * gone: the caller shows nothing else, the state of the area says it all.
   * Every other failure is the caller's own to show.
   */
  report: (error: unknown) => boolean;
}

/**
 * The rights of the session over the area, as the panels read them.
 *
 * The hook owns the state of the refusal, so every panel of the area answers
 * a lost right the same way: the one helper, one state, one message.
 */
export function useWebScanRights(): WebScanRights {
  const [lost, setLost] = useState(false);
  const report = useCallback((error: unknown): boolean => {
    if (!isPermissionLost(error)) return false;
    setLost(true);
    return true;
  }, []);
  return useMemo(() => ({ lost, report }), [lost, report]);
}
