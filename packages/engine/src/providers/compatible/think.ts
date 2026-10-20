/**
 * A `<think>…</think>` block in an answer: a model whose thinking could not be split out writes
 * it inside `content`, and the answer the caller reads must be the text that follows it.
 */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
const THINK_CLOSE_TAG = /<\/think>/i;

/** The longest tail of the dropped text that can still open the closing tag. */
const CARRY_LENGTH = THINK_CLOSE.length - 1;

/**
 * Drops a leading `<think>…</think>` block from a streamed answer. The text is held back
 * until it is clear that it does not open such a block, so a block split over several chunks
 * is still recognised, and an answer that starts with anything else is handed on unchanged.
 * Only the block at the very start of the answer is dropped: once real text has been handed
 * on, everything else passes through, so a `<think>` quoted inside the answer is kept.
 */
export class ThinkFilter {
  #pending = '';
  #dropping = false;
  /** The tail of the dropped text that may still open the closing tag. */
  #carry = '';
  /** Set once the leading block is settled: every later text belongs to the answer. */
  #settled = false;

  /** The text that can be handed on now; empty while the block may still open. */
  push(text: string): string {
    if (this.#settled) return text;
    if (this.#dropping) return this.#drop(text);
    this.#pending += text;
    const trimmed = this.#pending.trimStart();
    if (trimmed === '') return '';
    if (trimmed.toLowerCase().startsWith(THINK_OPEN)) {
      const end = THINK_CLOSE_TAG.exec(trimmed);
      if (!end) {
        this.#dropping = true;
        // The closing tag may be split after this chunk: keep the tail that may still open it.
        this.#carry = trimmed.slice(THINK_OPEN.length).slice(-CARRY_LENGTH);
        this.#pending = '';
        return '';
      }
      this.#pending = '';
      this.#settled = true;
      return trimmed.slice(end.index + end[0].length);
    }
    // The text may still turn into a `<think>` block with the next chunk.
    if (THINK_OPEN.startsWith(trimmed.toLowerCase())) return '';
    const out = this.#pending;
    this.#pending = '';
    this.#settled = true;
    return out;
  }

  /**
   * The text left when the stream ends. `unterminated` says the stream ended while the block
   * was still open, so the answer was never complete and the caller must not use it.
   */
  flush(): { text: string; unterminated: boolean } {
    const text = this.#pending;
    this.#pending = '';
    const unterminated = this.#dropping;
    this.#dropping = false;
    this.#carry = '';
    return { text, unterminated };
  }

  /** The text after the closing tag, dropping everything the block covered. */
  #drop(text: string): string {
    const window = this.#carry + text;
    const end = THINK_CLOSE_TAG.exec(window);
    if (!end) {
      this.#carry = window.slice(-CARRY_LENGTH);
      return '';
    }
    this.#dropping = false;
    this.#carry = '';
    this.#settled = true;
    return window.slice(end.index + end[0].length);
  }
}
