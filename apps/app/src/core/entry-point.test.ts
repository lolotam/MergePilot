import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEntryPoint } from './entry-point.js';

describe('isEntryPoint', () => {
  const script = resolve('dist', 'server', 'main.js');
  const url = pathToFileURL(script).href;

  it('matches the script node was started with, on this platform\'s path form', () => {
    expect(isEntryPoint(url, script)).toBe(true);
  });

  it('matches a relative script path, as `node dist/server/main.js` passes it', () => {
    expect(isEntryPoint(url, 'dist/server/main.js')).toBe(true);
  });

  it('does not match another script, nor a missing one (imported as a module)', () => {
    expect(isEntryPoint(url, resolve('dist', 'worker', 'main.js'))).toBe(false);
    expect(isEntryPoint(url, undefined)).toBe(false);
  });
});
