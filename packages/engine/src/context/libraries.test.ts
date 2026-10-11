import { describe, expect, it } from 'vitest';
import {
  detectTouchedLibraries,
  parseManifestVersions,
} from './libraries.js';

describe('parseManifestVersions', () => {
  it('extracts concrete versions from dependencies, devDependencies, and peerDependencies', () => {
    const pkgJson = JSON.stringify({
      dependencies: {
        react: '^18.2.0',
        lodash: '~4.17.21',
        express: '4.18.2',
      },
      devDependencies: {
        typescript: '~5.3.3',
        vitest: '^1.0.0',
      },
      peerDependencies: {
        'react-dom': '^18.2.0',
      },
    });

    const versions = parseManifestVersions(pkgJson);

    expect(versions.get('react')).toBe('18.2.0');
    expect(versions.get('lodash')).toBe('4.17.21');
    expect(versions.get('express')).toBe('4.18.2');
    expect(versions.get('typescript')).toBe('5.3.3');
    expect(versions.get('vitest')).toBe('1.0.0');
    expect(versions.get('react-dom')).toBe('18.2.0');
  });

  it('strips various range operators to concrete-looking versions', () => {
    const pkgJson = JSON.stringify({
      dependencies: {
        a: '^1.2.3',
        b: '~1.2',
        c: '>=2.0.0',
        d: '<=3.1.0',
        e: '=4.0.0',
        f: 'v5.1.2',
        g: '>= 1.0.0 < 2.0.0',
      },
    });

    const versions = parseManifestVersions(pkgJson);

    expect(versions.get('a')).toBe('1.2.3');
    expect(versions.get('b')).toBe('1.2');
    expect(versions.get('c')).toBe('2.0.0');
    expect(versions.get('d')).toBe('3.1.0');
    expect(versions.get('e')).toBe('4.0.0');
    expect(versions.get('f')).toBe('5.1.2');
    expect(versions.get('g')).toBe('1.0.0');
  });

  it('skips non-concrete specifiers: workspace, file, link, git, latest, *', () => {
    const pkgJson = JSON.stringify({
      dependencies: {
        'pkg-ws': 'workspace:*',
        'pkg-ws-range': 'workspace:^1.0.0',
        'pkg-file': 'file:../local-pkg',
        'pkg-link': 'link:../linked-pkg',
        'pkg-git': 'git+https://github.com/foo/bar.git',
        'pkg-gh': 'foo/bar',
        'pkg-star': '*',
        'pkg-latest': 'latest',
        'pkg-valid': '^2.0.0',
      },
    });

    const versions = parseManifestVersions(pkgJson);

    expect(versions.has('pkg-ws')).toBe(false);
    expect(versions.has('pkg-ws-range')).toBe(false);
    expect(versions.has('pkg-file')).toBe(false);
    expect(versions.has('pkg-link')).toBe(false);
    expect(versions.has('pkg-git')).toBe(false);
    expect(versions.has('pkg-gh')).toBe(false);
    expect(versions.has('pkg-star')).toBe(false);
    expect(versions.has('pkg-latest')).toBe(false);
    expect(versions.get('pkg-valid')).toBe('2.0.0');
  });

  it('prefers dependencies over devDependencies and peerDependencies on duplicates', () => {
    const pkgJson = JSON.stringify({
      dependencies: {
        foo: '^1.0.0',
      },
      devDependencies: {
        foo: '^2.0.0',
        bar: '^2.0.0',
      },
      peerDependencies: {
        bar: '^3.0.0',
      },
    });

    const versions = parseManifestVersions(pkgJson);

    expect(versions.get('foo')).toBe('1.0.0');
    expect(versions.get('bar')).toBe('2.0.0');
  });

  it('returns an empty map on invalid or malformed JSON', () => {
    expect(parseManifestVersions('{ invalid json }').size).toBe(0);
    expect(parseManifestVersions('').size).toBe(0);
    expect(parseManifestVersions('[]').size).toBe(0);
    expect(parseManifestVersions('{"dependencies": "invalid"}').size).toBe(0);
  });
});

describe('detectTouchedLibraries', () => {
  const versions = new Map<string, string>([
    ['react', '18.2.0'],
    ['lodash', '4.17.21'],
    ['zod', '3.22.0'],
    ['axios', '1.6.0'],
    ['@scope/pkg', '1.0.0'],
    ['@scope/other', '2.0.0'],
    ['express', '4.18.2'],
  ]);

  it('detects imports in added lines across various syntax forms', () => {
    const patch = `
@@ -10,3 +10,8 @@
 const old = 1;
-import { oldLib } from 'old-lib';
+import React from 'react';
+import { debounce } from 'lodash/debounce';
+import * as z from 'zod';
+import type { Express } from 'express';
+const axios = require('axios');
+const other = await import('@scope/pkg/subpath');
`;

    const files = [{ path: 'src/app.ts', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual([
      'react',
      'lodash',
      'zod',
      'express',
      'axios',
      '@scope/pkg',
    ]);
  });

  it('detects side-effect imports', () => {
    const patch = `
@@ -1,3 +1,3 @@
-import 'old';
+import '@scope/other';
`;
    const files = [{ path: 'src/main.tsx', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['@scope/other']);
  });

  it('handles multiline imports in added lines', () => {
    const patch = `
@@ -1,2 +1,6 @@
+import {
+  cloneDeep,
+  map,
+} from 'lodash';
`;
    const files = [{ path: 'src/util.js', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['lodash']);
  });

  it('skips non-JS/TS files and files without patches', () => {
    const patch = `
@@ -1,2 +1,3 @@
+import React from 'react';
`;
    const files = [
      { path: 'README.md', patch },
      { path: 'styles.css', patch },
      { path: 'data.json', patch },
      { path: 'src/no-patch.ts' },
    ];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual([]);
  });

  it('skips relative imports and node: built-ins', () => {
    const patch = `
@@ -1,3 +1,6 @@
+import { helper } from './helper.js';
+import { parent } from '../parent.js';
+import fs from 'node:fs';
+import path from 'node:path/posix';
+import { z } from 'zod';
`;
    const files = [{ path: 'src/index.mts', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['zod']);
  });

  it('only returns libraries present in versions', () => {
    const patch = `
@@ -1,2 +1,4 @@
+import unknownLib from 'unknown-lib';
+import { z } from 'zod';
`;
    const files = [{ path: 'src/test.cjs', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['zod']);
  });

  it('preserves order of first appearance and removes duplicates', () => {
    const patch1 = `
@@ -1,2 +1,4 @@
+import { z } from 'zod';
+import React from 'react';
`;
    const patch2 = `
@@ -1,2 +1,5 @@
+import { z } from 'zod';
+const _ = require('lodash');
+import React from 'react';
`;
    const files = [
      { path: 'src/first.ts', patch: patch1 },
      { path: 'src/second.tsx', patch: patch2 },
    ];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['zod', 'react', 'lodash']);
  });

  it('ignores lines that are not added lines', () => {
    const patch = `
@@ -1,5 +1,5 @@
 import React from 'react';
-const _ = require('lodash');
+const z = require('zod');
`;
    const files = [{ path: 'src/diff.ts', patch }];
    const touched = detectTouchedLibraries(files, versions);

    expect(touched).toEqual(['zod']);
  });
});
