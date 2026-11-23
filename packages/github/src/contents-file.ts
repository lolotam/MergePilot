interface EncodedContent {
  content?: unknown;
  encoding?: unknown;
}

/** Decode a Git Blob response only when it contains base64 content. */
export function blobFileText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const blob = data as EncodedContent;
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') return null;
  return Buffer.from(blob.content, 'base64').toString('utf8');
}

/** Read a Contents API file, optionally resolving content omitted by the API through its blob. */
export async function contentsFileText(
  data: unknown,
  opts: { maxBytes?: number | undefined; readBlob: (sha: string) => Promise<string | null> },
): Promise<string | null> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const item = data as EncodedContent & { type?: unknown; sha?: unknown; size?: unknown };
  if (item.type !== 'file') return null;
  // Contents can return either empty content or no content for files over 1 MB.
  if (item.encoding === 'none') {
    if (opts.maxBytes !== undefined && typeof item.sha === 'string'
      && typeof item.size === 'number' && item.size <= opts.maxBytes) {
      return opts.readBlob(item.sha);
    }
    return null;
  }
  if (typeof item.content !== 'string') return null;
  return (item.encoding ?? 'base64') === 'base64'
    ? Buffer.from(item.content, 'base64').toString('utf8')
    : item.content;
}
