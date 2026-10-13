import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../..');
const outdir = resolve(repoRoot, 'dist/action');

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(currentDir, 'src/index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});

// esbuild marks each module with a `// <path>` comment. pnpm shortens long store folder
// names on Windows only, so those comments differ by OS and the committed bundle would never
// match CI's rebuild. Lazy __esm/__commonJS initializers also use those paths as diagnostic
// object keys. Normalize the keys to the public package path and drop path comments.
const outfile = resolve(outdir, 'index.js');
const stripped = readFileSync(outfile, 'utf8')
  .split('\n')
  .filter((line) => !/^\/\/ (\.\.\/)+(node_modules|packages|apps)\//.test(line))
  .map((line) => line.replace(/^(\s*)"(?:\.\.\/)+node_modules\/\.pnpm\/[^/]+\/node_modules\/([^"]+)"(?=\([^)]*\) \{)/, '$1"$2"'))
  .join('\n');
writeFileSync(outfile, stripped);
