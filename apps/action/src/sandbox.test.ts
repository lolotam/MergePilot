import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSanitizedWorkspace } from './sandbox.js';

describe('createSanitizedWorkspace', () => {
  describe('unit tests with injected dependencies', () => {
    it('excludes every listed file at root and nested', async () => {
      const files = [
        // Excluded files at root
        'CLAUDE.md',
        'CLAUDE.local.md',
        '.claude/settings.json',
        '.claude/commands/test.md',
        '.mcp.json',
        'AGENTS.md',
        '.cursor/rules',
        '.github/copilot-instructions.md',
        // Excluded files nested
        'packages/engine/CLAUDE.md',
        'sub/dir/CLAUDE.local.md',
        'nested/.claude/hooks/pre-tool',
        'deep/path/.mcp.json',
        'docs/AGENTS.md',
        'packages/.cursor/settings',
        'nested/.github/copilot-instructions.md',
        // Sensitive paths flagged by isSensitivePath
        '.env',
        'nested/.env',
        '.env.local',
        '.env.production',
        'id_rsa',
        'nested/id_rsa',
        'id_ed25519',
        'secret.key',
        'nested/secret.key',
        'cert.pem',
        'cert.p12',
        'cert.pfx',
        'credentials.json',
        '.npmrc',
        '.pypirc',
        // Allowed files
        'src/index.ts',
        'package.json',
        'README.md',
        '.env.example',
        'nested/.env.example',
        '.github/workflows/ci.yml',
      ];

      const copiedFiles: string[] = [];
      const fakeMkdtemp = async (_prefix: string) => '/tmp/sandbox-123';
      const fakeListFiles = async (_dir: string) => files;
      const fakeCopyFile = async (_src: string, dest: string) => {
        copiedFiles.push(dest);
      };

      const workspace = await createSanitizedWorkspace({
        sourceDir: '/source/repo',
        listFiles: fakeListFiles,
        copyFile: fakeCopyFile,
        mkdtemp: fakeMkdtemp,
      });

      expect(workspace.dir).toBe('/tmp/sandbox-123');

      // Check allowed files were copied
      const copiedNorm = copiedFiles.map((p) => p.replace(/\\/g, '/'));
      expect(copiedNorm).toContain('/tmp/sandbox-123/src/index.ts');
      expect(copiedNorm).toContain('/tmp/sandbox-123/package.json');
      expect(copiedNorm).toContain('/tmp/sandbox-123/README.md');
      expect(copiedNorm).toContain('/tmp/sandbox-123/.env.example');
      expect(copiedNorm).toContain('/tmp/sandbox-123/nested/.env.example');
      expect(copiedNorm).toContain('/tmp/sandbox-123/.github/workflows/ci.yml');

      // Check excluded files were NOT copied
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/CLAUDE.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/CLAUDE.local.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.claude/settings.json');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.claude/commands/test.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.mcp.json');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/AGENTS.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.cursor/rules');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.github/copilot-instructions.md');

      expect(copiedNorm).not.toContain('/tmp/sandbox-123/packages/engine/CLAUDE.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/sub/dir/CLAUDE.local.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/nested/.claude/hooks/pre-tool');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/deep/path/.mcp.json');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/docs/AGENTS.md');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/packages/.cursor/settings');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/nested/.github/copilot-instructions.md');

      // Check sensitive files were NOT copied
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.env');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/nested/.env');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.env.local');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.env.production');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/id_rsa');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/id_ed25519');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/secret.key');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/cert.pem');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/cert.p12');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/cert.pfx');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/credentials.json');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.npmrc');
      expect(copiedNorm).not.toContain('/tmp/sandbox-123/.pypirc');

      expect(copiedFiles.length).toBe(6);
    });

    it('cleanup removes the dir with custom rm', async () => {
      let removedDir = '';
      const fakeRm = async (dir: string) => {
        removedDir = dir;
      };

      const workspace = await createSanitizedWorkspace({
        sourceDir: '/source/repo',
        listFiles: async () => [],
        copyFile: async () => {},
        mkdtemp: async () => '/tmp/sandbox-custom-rm',
        rm: fakeRm,
      });

      expect(workspace.dir).toBe('/tmp/sandbox-custom-rm');
      await workspace.cleanup();
      expect(removedDir).toBe('/tmp/sandbox-custom-rm');
    });
  });

  describe('filesystem integration tests with real temporary directories', () => {
    it('copies normal files, excludes targets, skips symlinks and .git, and cleanup removes dir', async () => {
      const sourceDir = await mkdtemp(join(tmpdir(), 'test-src-'));

      try {
        // Create normal files
        await mkdir(join(sourceDir, 'src'), { recursive: true });
        await writeFile(join(sourceDir, 'src/index.ts'), 'console.log("hello");');
        await writeFile(join(sourceDir, 'README.md'), '# Test Project');
        await writeFile(join(sourceDir, '.env.example'), 'PORT=3000');

        // Create files to exclude at root
        await writeFile(join(sourceDir, 'CLAUDE.md'), '# Claude config');
        await writeFile(join(sourceDir, 'CLAUDE.local.md'), '# Local instructions');
        await writeFile(join(sourceDir, '.mcp.json'), '{}');
        await writeFile(join(sourceDir, 'AGENTS.md'), '# Agents');
        await writeFile(join(sourceDir, '.env'), 'SECRET=topsecret');

        // Create .claude and .cursor dirs with files
        await mkdir(join(sourceDir, '.claude'), { recursive: true });
        await writeFile(join(sourceDir, '.claude/settings.json'), '{}');
        await mkdir(join(sourceDir, '.cursor'), { recursive: true });
        await writeFile(join(sourceDir, '.cursor/rules'), '{}');

        // Create .github/copilot-instructions.md
        await mkdir(join(sourceDir, '.github'), { recursive: true });
        await writeFile(join(sourceDir, '.github/copilot-instructions.md'), '# Copilot');
        await writeFile(join(sourceDir, '.github/workflow.yml'), 'name: CI');

        // Create nested excluded files
        await mkdir(join(sourceDir, 'nested/subdir'), { recursive: true });
        await writeFile(join(sourceDir, 'nested/subdir/CLAUDE.md'), '# Nested claude');
        await writeFile(join(sourceDir, 'nested/subdir/.env.local'), 'SECRET=123');
        await writeFile(join(sourceDir, 'nested/subdir/id_rsa'), 'private-key');

        // Create .git directory with files (must be skipped)
        await mkdir(join(sourceDir, '.git/objects'), { recursive: true });
        await writeFile(join(sourceDir, '.git/HEAD'), 'ref: refs/heads/main');
        await writeFile(join(sourceDir, '.git/config'), '[core]');

        // Create node_modules directory with files (must be skipped)
        await mkdir(join(sourceDir, 'node_modules/fake-pkg'), { recursive: true });
        await writeFile(join(sourceDir, 'node_modules/fake-pkg/index.js'), 'export {}');

        // Create a symlink (must be skipped)
        try {
          await symlink(join(sourceDir, 'README.md'), join(sourceDir, 'symlink-readme.md'));
        } catch {
          // On Windows without developer mode/admin rights, symlink creation might fail;
          // if it fails to create the fixture, we skip testing symlink creation here.
        }

        const workspace = await createSanitizedWorkspace({ sourceDir });

        expect(existsSync(workspace.dir)).toBe(true);

        // Verify normal files were copied
        expect(existsSync(join(workspace.dir, 'src/index.ts'))).toBe(true);
        expect(existsSync(join(workspace.dir, 'README.md'))).toBe(true);
        expect(existsSync(join(workspace.dir, '.env.example'))).toBe(true);
        expect(existsSync(join(workspace.dir, '.github/workflow.yml'))).toBe(true);

        // Verify excluded files were NOT copied
        expect(existsSync(join(workspace.dir, 'CLAUDE.md'))).toBe(false);
        expect(existsSync(join(workspace.dir, 'CLAUDE.local.md'))).toBe(false);
        expect(existsSync(join(workspace.dir, '.mcp.json'))).toBe(false);
        expect(existsSync(join(workspace.dir, 'AGENTS.md'))).toBe(false);
        expect(existsSync(join(workspace.dir, '.env'))).toBe(false);
        expect(existsSync(join(workspace.dir, '.claude'))).toBe(false);
        expect(existsSync(join(workspace.dir, '.cursor'))).toBe(false);
        expect(existsSync(join(workspace.dir, '.github/copilot-instructions.md'))).toBe(false);

        // Verify nested excluded files were NOT copied
        expect(existsSync(join(workspace.dir, 'nested/subdir/CLAUDE.md'))).toBe(false);
        expect(existsSync(join(workspace.dir, 'nested/subdir/.env.local'))).toBe(false);
        expect(existsSync(join(workspace.dir, 'nested/subdir/id_rsa'))).toBe(false);

        // Verify .git and node_modules were NOT copied
        expect(existsSync(join(workspace.dir, '.git'))).toBe(false);
        expect(existsSync(join(workspace.dir, 'node_modules'))).toBe(false);

        // Verify symlink was NOT copied
        expect(existsSync(join(workspace.dir, 'symlink-readme.md'))).toBe(false);

        // Test cleanup
        await workspace.cleanup();
        expect(existsSync(workspace.dir)).toBe(false);
      } finally {
        await rm(sourceDir, { recursive: true, force: true });
      }
    });
  });

  it('never copies a path that escapes the source directory', async () => {
    const copied: string[] = [];
    await createSanitizedWorkspace({
      sourceDir: '/repo',
      listFiles: () => ['src/a.ts', '../outside.txt', '../../etc/passwd'],
      copyFile: (_src, dest) => {
        copied.push(dest);
      },
      mkdtemp: () => '/tmp/sandbox',
      rm: () => undefined,
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]?.replaceAll('\\', '/')).toMatch(/src\/a\.ts$/);
  });
});
