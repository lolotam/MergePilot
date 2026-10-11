const REDACTED_MARKER = '[REDACTED]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED_MARKER;
  }

  toJSON(): string {
    return REDACTED_MARKER;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED_MARKER;
  }
}
