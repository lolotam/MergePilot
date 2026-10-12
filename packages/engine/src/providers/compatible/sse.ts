/**
 * Server-Sent Events parsing for streaming Chat Completions. Ported from the owner's
 * Browser-controle extension (`src/lib/sse.js` parseSseChunk), converted to TypeScript.
 */

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a growing SSE text buffer into complete events plus the trailing partial text. */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** Yields the SSE events of a response body until it ends. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      yield* events;
    }
    buffer += decoder.decode();
    yield* parseSseChunk(`${buffer}\n\n`).events;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
