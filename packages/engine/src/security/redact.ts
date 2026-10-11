import type { Secret } from '../credentials/secret.js';

export type RedactionKind =
  | 'known'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'github'
  | 'aws'
  | 'pem'
  | 'generic';

export interface RedactionFinding {
  kind: string;
  line: number;
}

export interface RedactResult {
  text: string;
  found: RedactionFinding[];
}

interface MatchCandidate {
  start: number;
  end: number;
  kind: string;
  line: number;
  replacement: string;
  priority: number;
}

function computeLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function getLineFromOffsets(offsets: number[], index: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const offset = offsets[mid] ?? 0;
    if (offset <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

interface TokenPattern {
  regex: RegExp;
  kind: RedactionKind;
  priority: number;
}

const TOKEN_PATTERNS: readonly TokenPattern[] = [
  {
    regex: /-----BEGIN (?:[A-Z0-9_-]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )*PRIVATE KEY-----/g,
    kind: 'pem',
    priority: 60,
  },
  { regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g, kind: 'anthropic', priority: 50 },
  { regex: /(?<![A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, kind: 'openai', priority: 50 },
  { regex: /(?<![A-Za-z0-9_-])sk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, kind: 'openai', priority: 50 },
  { regex: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, kind: 'google', priority: 50 },
  { regex: /(?<![A-Za-z0-9_])(?:gh[posu]|github_pat)_[A-Za-z0-9_]{8,}(?![A-Za-z0-9_])/g, kind: 'github', priority: 50 },
  { regex: /(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])/g, kind: 'aws', priority: 50 },
];

/**
 * Replaces known secret values and well-known credential formats with `[REDACTED:<kind>]`
 * before any text leaves the runner. Overlaps resolve by priority, then length, then position.
 */
export function redactSecrets(text: string, knownSecrets: Secret[] = []): RedactResult {
  const lineOffsets = computeLineOffsets(text);
  const candidates: MatchCandidate[] = [];

  for (const secret of knownSecrets) {
    const value = secret.reveal();
    if (!value || value.trim().length === 0) {
      continue;
    }
    let searchIdx = 0;
    while (searchIdx < text.length) {
      const foundIdx = text.indexOf(value, searchIdx);
      if (foundIdx === -1) {
        break;
      }
      candidates.push({
        start: foundIdx,
        end: foundIdx + value.length,
        kind: 'known',
        line: getLineFromOffsets(lineOffsets, foundIdx),
        replacement: '[REDACTED:known]',
        priority: 100,
      });
      searchIdx = foundIdx + value.length;
    }
  }

  for (const { regex, kind, priority } of TOKEN_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        kind,
        line: getLineFromOffsets(lineOffsets, match.index),
        replacement: `[REDACTED:${kind}]`,
        priority,
      });
    }
  }

  // Generic assignments (= or :) with quoted values of 8+ chars
  const genericRegex = /(?:(?:\b|['"])[a-zA-Z0-9_]*(?:password|passwd|secret|token|api_key|apikey)['"]?\s*[=:]\s*)(["'`])((?:\\.|(?!\1)[^\r\n\\]){8,})\1/gi;
  let genMatch: RegExpExecArray | null;
  while ((genMatch = genericRegex.exec(text)) !== null) {
    const fullMatch = genMatch[0];
    const quote = genMatch[1] ?? '';
    const val = genMatch[2] ?? '';
    const target = `${quote}${val}${quote}`;
    const quoteStartInMatch = fullMatch.lastIndexOf(target);
    const valStart = quoteStartInMatch !== -1
      ? genMatch.index + quoteStartInMatch + quote.length
      : genMatch.index + fullMatch.indexOf(val);
    const valEnd = valStart + val.length;

    candidates.push({
      start: valStart,
      end: valEnd,
      kind: 'generic',
      line: getLineFromOffsets(lineOffsets, genMatch.index),
      replacement: '[REDACTED:generic]',
      priority: 10,
    });
  }

  // Resolve conflicts by priority descending, then length descending, then start ascending
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) {
      return lenB - lenA;
    }
    return a.start - b.start;
  });

  const accepted: MatchCandidate[] = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some(
      (existing) => !(candidate.end <= existing.start || candidate.start >= existing.end),
    );
    if (!overlaps) {
      accepted.push(candidate);
    }
  }

  accepted.sort((a, b) => a.start - b.start);

  let redactedText = '';
  let lastIndex = 0;
  const found: RedactionFinding[] = [];

  for (const match of accepted) {
    redactedText += text.slice(lastIndex, match.start);
    redactedText += match.replacement;
    lastIndex = match.end;
    found.push({ kind: match.kind, line: match.line });
  }
  redactedText += text.slice(lastIndex);

  return {
    text: redactedText,
    found,
  };
}
