import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * The site the scan panels work on.
 *
 * The site is chosen once and kept while the administrator moves between the
 * sections of the area, so the scan, the findings and the exceptions of one
 * site always belong together.
 */
export interface WebScanSelection {
  /** The site the panels work on, when one is chosen. */
  siteId: string | undefined;
  setSiteId: (siteId: string) => void;
}

const WebScanSelectionContext = createContext<WebScanSelection | null>(null);

export function WebScanSelectionProvider({ children }: { children: ReactNode }) {
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const value = useMemo(() => ({ siteId, setSiteId }), [siteId]);
  return (
    <WebScanSelectionContext.Provider value={value}>{children}</WebScanSelectionContext.Provider>
  );
}

export function useWebScanSelection(): WebScanSelection {
  const context = useContext(WebScanSelectionContext);
  if (!context) {
    throw new Error('useWebScanSelection must be used within a WebScanSelectionProvider');
  }
  return context;
}
