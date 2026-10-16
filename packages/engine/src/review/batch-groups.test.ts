import { describe, expect, it } from 'vitest';
import { FileTier, fileTierOf, implementationKeyOf } from './batch-groups.js';

describe('batch-groups - fileTierOf (ADR-0031)', () => {
  it.each([
    ['packages/engine/src/review/split.ts', FileTier.Source],
    ['app/models/user.py', FileTier.Source],
    ['src/components/notice.tsx', FileTier.Source],
    ['packages/engine/src/review/split.test.ts', FileTier.Test],
    ['src/__tests__/view.test.tsx', FileTier.Test],
    ['pkg/test_parser.py', FileTier.Test],
    ['cmd/server_test.go', FileTier.Test],
    ['.github/workflows/ci.yml', FileTier.Config],
    ['tsconfig.base.json', FileTier.Config],
    ['Dockerfile', FileTier.Config],
    ['vitest.config.ts', FileTier.Config],
    ['docs/adr/0031-batch-grouping-and-manifest.md', FileTier.Docs],
    ['pnpm-lock.yaml', FileTier.Docs],
    ['LICENSE', FileTier.Docs],
    ['requirements-dev.txt', FileTier.Config],
    ['src/__snapshots__/view.test.tsx.snap', FileTier.Docs],
  ])('%s is tier %i', (path, tier) => {
    expect(fileTierOf(path)).toBe(tier);
  });
});

describe('batch-groups - implementationKeyOf', () => {
  it.each([
    ['src/x.ts', 'src/x'],
    ['src/x.test.ts', 'src/x'],
    ['src/x.spec.tsx', 'src/x'],
    ['src/__tests__/x.test.ts', 'src/x'],
    ['pkg/x.py', 'pkg/x'],
    ['pkg/test_x.py', 'pkg/x'],
    ['pkg/x_test.py', 'pkg/x'],
    ['pkg/tests/test_x.py', 'pkg/x'],
    ['cmd/x_test.go', 'cmd/x'],
  ])('%s belongs to %s', (path, key) => {
    expect(implementationKeyOf(path)).toBe(key);
  });
});
