import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts Anthropic keys and records 1-based line number', () => {
    const input = 'line 1\nconst anthropic = "sk-ant-api03-testFakeKey1234567890";\nline 3';
    const result = redactSecrets(input);

    expect(result.text).toBe('line 1\nconst anthropic = "[REDACTED:anthropic]";\nline 3');
    expect(result.found).toEqual([{ kind: 'anthropic', line: 2 }]);
  });

  it('redacts OpenAI standard keys with at least 20 chars after sk- prefix', () => {
    const input = 'const openai = "sk-abcdefghijklmnopqrstuvwxyz1234";';
    const result = redactSecrets(input);

    expect(result.text).toBe('const openai = "[REDACTED:openai]";');
    expect(result.found).toEqual([{ kind: 'openai', line: 1 }]);
  });

  it('redacts OpenAI project keys with at least 20 chars after sk-proj- prefix', () => {
    const input = 'const proj = "sk-proj-abcdefghijklmnopqrstuvwxyz1234";';
    const result = redactSecrets(input);

    expect(result.text).toBe('const proj = "[REDACTED:openai]";');
    expect(result.found).toEqual([{ kind: 'openai', line: 1 }]);
  });

  it('redacts Google API keys (AIza + 35 chars)', () => {
    const googleKey = 'AIzaSy' + 'A'.repeat(33); // 4 + 35 = 39 chars total
    const input = `const gkey = "${googleKey}";`;
    const result = redactSecrets(input);

    expect(result.text).toBe('const gkey = "[REDACTED:google]";');
    expect(result.found).toEqual([{ kind: 'google', line: 1 }]);
  });

  it('redacts all GitHub token variants', () => {
    const input = [
      'ghp = "ghp_0123456789abcdefghijklmnopqrst"',
      'gho = "gho_0123456789abcdefghijklmnopqrst"',
      'ghs = "ghs_0123456789abcdefghijklmnopqrst"',
      'ghu = "ghu_0123456789abcdefghijklmnopqrst"',
      'pat = "github_pat_0123456789abcdefghijklmnopqrst"',
    ].join('\n');

    const result = redactSecrets(input);

    expect(result.text).toBe([
      'ghp = "[REDACTED:github]"',
      'gho = "[REDACTED:github]"',
      'ghs = "[REDACTED:github]"',
      'ghu = "[REDACTED:github]"',
      'pat = "[REDACTED:github]"',
    ].join('\n'));

    expect(result.found).toEqual([
      { kind: 'github', line: 1 },
      { kind: 'github', line: 2 },
      { kind: 'github', line: 3 },
      { kind: 'github', line: 4 },
      { kind: 'github', line: 5 },
    ]);
  });

  it('redacts AWS access key ids (AKIA + 16 uppercase/digits)', () => {
    const input = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);

    expect(result.text).toBe('aws_access_key_id = [REDACTED:aws]');
    expect(result.found).toEqual([{ kind: 'aws', line: 1 }]);
  });

  it('redacts multi-line PEM private key blocks and preserves line of start', () => {
    const pemBlock = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAzFakeKeyContentsForTestingPurposesOnly...',
      'AnotherLineOfBase64Data...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const input = `preface\n${pemBlock}\npostscript`;
    const result = redactSecrets(input);

    expect(result.text).toBe('preface\n[REDACTED:pem]\npostscript');
    expect(result.found).toEqual([{ kind: 'pem', line: 2 }]);
  });

  it('redacts generic assignments with quoted values of 8+ chars (= and :)', () => {
    const input = [
      'password = "mySecretPassword123"',
      'passwd: \'anotherSecretPassword\'',
      '"secret": "jsonConfiguredSecret123"',
      'token = "tokenValue12345"',
      'api_key: "genericApiKey123"',
      'apikey = "yetAnotherApiKey123"',
    ].join('\n');

    const result = redactSecrets(input);

    expect(result.text).toBe([
      'password = "[REDACTED:generic]"',
      'passwd: \'[REDACTED:generic]\'',
      '"secret": "[REDACTED:generic]"',
      'token = "[REDACTED:generic]"',
      'api_key: "[REDACTED:generic]"',
      'apikey = "[REDACTED:generic]"',
    ].join('\n'));

    expect(result.found).toEqual([
      { kind: 'generic', line: 1 },
      { kind: 'generic', line: 2 },
      { kind: 'generic', line: 3 },
      { kind: 'generic', line: 4 },
      { kind: 'generic', line: 5 },
      { kind: 'generic', line: 6 },
    ]);
  });

  it('does NOT flag a 7-character password, but flags an 8-character password', () => {
    const input = 'const shortPassword = "1234567";\nconst minPassword = "12345678";';
    const result = redactSecrets(input);

    expect(result.text).toBe('const shortPassword = "1234567";\nconst minPassword = "[REDACTED:generic]";');
    expect(result.found).toEqual([{ kind: 'generic', line: 2 }]);
  });

  it('redacts a known secret even when it matches no pattern', () => {
    const known = new Secret('custom-opaque-secret-xyz');
    const input = 'log message with custom-opaque-secret-xyz embedded in it';
    const result = redactSecrets(input, [known]);

    expect(result.text).toBe('log message with [REDACTED:known] embedded in it');
    expect(result.found).toEqual([{ kind: 'known', line: 1 }]);
  });

  it('redacts multiple occurrences of known secrets with correct line numbers', () => {
    const known = new Secret('sk-test-000');
    const input = 'line 1: sk-test-000\nline 2: clean\nline 3: sk-test-000 again';
    const result = redactSecrets(input, [known]);

    expect(result.text).toBe('line 1: [REDACTED:known]\nline 2: clean\nline 3: [REDACTED:known] again');
    expect(result.found).toEqual([
      { kind: 'known', line: 1 },
      { kind: 'known', line: 3 },
    ]);
  });

  it('prioritizes specific secret pattern when inside generic assignment', () => {
    const input = 'api_key = "sk-ant-testSecretKey1234567890"';
    const result = redactSecrets(input);

    expect(result.text).toBe('api_key = "[REDACTED:anthropic]"');
    expect(result.found).toEqual([{ kind: 'anthropic', line: 1 }]);
  });

  it('handles empty input and clean text without false positives', () => {
    expect(redactSecrets('')).toEqual({ text: '', found: [] });
    expect(redactSecrets('const x = 123;\nconst y = "hello";')).toEqual({
      text: 'const x = 123;\nconst y = "hello";',
      found: [],
    });
  });

  it('does NOT redact keys that fall short of minimum length requirements', () => {
    const shortOai = 'const k1 = "sk-onlyTwelveChar";'; // 14 chars after sk-, requires 20+
    const shortGoogle = 'const k2 = "AIzaSy' + 'A'.repeat(30) + '";'; // 32 chars after AIza, requires 35
    const lowerAws = 'const k3 = "akia1234567890ABCDEF";'; // lowercase AKIA

    const input = `${shortOai}\n${shortGoogle}\n${lowerAws}`;
    const result = redactSecrets(input);

    expect(result.text).toBe(input);
    expect(result.found).toEqual([]);
  });

  it('ignores empty or whitespace-only known secrets', () => {
    const emptySecret = new Secret('');
    const blankSecret = new Secret('   ');
    const input = 'some plain text without redactions';
    const result = redactSecrets(input, [emptySecret, blankSecret]);

    expect(result.text).toBe(input);
    expect(result.found).toEqual([]);
  });

  it('does not redact bare Anthropic key prefixes mentioned in documentation', () => {
    const input = 'The right token starts with `sk-ant-oat01-`; an API key starts with `sk-ant-api03-`.';
    const result = redactSecrets(input);
    expect(result.text).toBe(input);
    expect(result.found).toHaveLength(0);
  });
});
