import type { LibraryDoc } from '@mergepilot/engine';

export interface LibraryTarget {
  name: string;
  version: string;
}

export interface FetchLibraryDocsOptions {
  libraries: LibraryTarget[];
  source: 'npm' | 'context7' | 'none' | string;
  maxCharsPerLibrary: number;
  maxLibraries: number;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

function makeSignal(): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }
  return undefined;
}

interface NpmManifestResponse {
  name?: string;
  readme?: string;
  versions?: Record<string, { name?: string; version?: string; readme?: string }>;
}

/**
 * Fetches the README for a package from the npm registry.
 * Prefers the exact version README if available; falls back to top-level README.
 */
async function fetchNpmDoc(
  name: string,
  version: string,
  maxChars: number,
  fetchFn: typeof globalThis.fetch,
  fallbackNotice?: string,
): Promise<LibraryDoc | null> {
  try {
    // The registry expects scoped names as `@scope%2Fname` — the `@` must stay literal.
    const url = `https://registry.npmjs.org/${name.split('/').map(encodeURIComponent).join('%2F').replace(/^%40/, '@')}`;
    const signal = makeSignal();
    const res = await fetchFn(url, signal ? { signal } : undefined);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as NpmManifestResponse;
    const versionReadme = data.versions?.[version]?.readme;
    const topLevelReadme = data.readme;

    let header: string;
    let body: string;

    if (versionReadme && typeof versionReadme === 'string' && versionReadme.trim()) {
      const fallbackSuffix = fallbackNotice ? ` (${fallbackNotice})` : '';
      header = `Source: npm README for ${name}@${version}${fallbackSuffix}`;
      body = versionReadme;
    } else if (topLevelReadme && typeof topLevelReadme === 'string' && topLevelReadme.trim()) {
      const fallbackPrefix = fallbackNotice ? `${fallbackNotice}; ` : '';
      header = `Source: npm README for ${name}@${version} (${fallbackPrefix}latest README; exact version had none)`;
      body = topLevelReadme;
    } else {
      return null;
    }

    const fullContent = `${header}\n\n${body}`;
    const truncated = fullContent.slice(0, maxChars);
    return {
      name,
      version,
      source: 'npm',
      content: truncated,
    };
  } catch {
    return null;
  }
}

/**
 * Isolated helper for Context7 endpoints (search and doc retrieval).
 * Resolves query to match ID, then fetches token-budgeted documentation text.
 * Returns raw documentation text or null on failure/unexpected response shapes.
 */
async function fetchContext7Doc(
  name: string,
  apiKey: string,
  maxChars: number,
  fetchFn: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const searchUrl = `https://context7.com/api/v1/search?query=${encodeURIComponent(name)}`;
    const signal = makeSignal();
    const searchInit: RequestInit = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      ...(signal ? { signal } : {}),
    };
    const searchRes = await fetchFn(searchUrl, searchInit);
    if (!searchRes.ok) {
      return null;
    }

    const searchData = (await searchRes.json()) as unknown;
    let matchId: string | undefined;

    if (Array.isArray(searchData) && searchData.length > 0) {
      const first = searchData[0] as Record<string, unknown>;
      matchId = typeof first?.id === 'string' ? first.id : undefined;
    } else if (searchData && typeof searchData === 'object') {
      const obj = searchData as Record<string, unknown>;
      if (Array.isArray(obj.results) && obj.results.length > 0) {
        const first = obj.results[0] as Record<string, unknown>;
        matchId = typeof first?.id === 'string' ? first.id : undefined;
      } else if (Array.isArray(obj.data) && obj.data.length > 0) {
        const first = obj.data[0] as Record<string, unknown>;
        matchId = typeof first?.id === 'string' ? first.id : undefined;
      } else if (typeof obj.id === 'string') {
        matchId = obj.id;
      }
    }

    if (!matchId) {
      return null;
    }

    const approxTokens = Math.max(1, Math.round(maxChars / 4));
    // Context7 ids are paths like `/vercel/next.js`: encode each segment, keep the slashes.
    const idPath = matchId.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const docUrl = `https://context7.com/api/v1/${idPath}?type=txt&tokens=${approxTokens}`;
    const docInit: RequestInit = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      ...(signal ? { signal } : {}),
    };
    const docRes = await fetchFn(docUrl, docInit);
    if (!docRes.ok) {
      return null;
    }

    const text = await docRes.text();
    if (!text || !text.trim()) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * Fetches third-party documentation for exact library versions in use.
 * Supports 'npm' (default), 'context7' (opt-in), and 'none'.
 * Capped by maxLibraries and maxCharsPerLibrary. Failures are skipped, never thrown.
 */
export async function fetchLibraryDocs(
  opts: FetchLibraryDocsOptions,
): Promise<LibraryDoc[]> {
  const {
    libraries,
    source,
    maxCharsPerLibrary,
    maxLibraries,
    fetch: customFetch,
    env = process.env,
    log = console.warn,
  } = opts;

  if (source === 'none' || maxLibraries <= 0 || libraries.length === 0) {
    return [];
  }

  const fetchFn = customFetch ?? globalThis.fetch;
  const candidates = libraries.slice(0, maxLibraries);

  const docPromises = candidates.map(async (lib): Promise<LibraryDoc | null> => {
    try {
      if (source === 'context7') {
        const apiKey = env.CONTEXT7_API_KEY;
        if (!apiKey) {
          log('CONTEXT7_API_KEY is not set; falling back to npm');
          return fetchNpmDoc(
            lib.name,
            lib.version,
            maxCharsPerLibrary,
            fetchFn,
            'context7 fallback',
          );
        }

        const context7Text = await fetchContext7Doc(
          lib.name,
          apiKey,
          maxCharsPerLibrary,
          fetchFn,
        );

        if (context7Text) {
          const header = `Source: Context7 docs for ${lib.name}@${lib.version}`;
          const fullContent = `${header}\n\n${context7Text}`;
          return {
            name: lib.name,
            version: lib.version,
            source: 'context7',
            content: fullContent.slice(0, maxCharsPerLibrary),
          };
        }

        // On non-2xx or unexpected shape, fall back to npm
        return fetchNpmDoc(
          lib.name,
          lib.version,
          maxCharsPerLibrary,
          fetchFn,
          'context7 fallback',
        );
      }

      // Default to npm
      return fetchNpmDoc(lib.name, lib.version, maxCharsPerLibrary, fetchFn);
    } catch {
      return null;
    }
  });

  const results = await Promise.all(docPromises);
  return results.filter((doc): doc is LibraryDoc => doc !== null);
}
