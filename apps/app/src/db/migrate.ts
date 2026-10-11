import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryableClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

export interface ConnectableClient {
  connect(): Promise<QueryableClient & { release?: () => void }>;
}

export type MigrationClient = QueryableClient | ConnectableClient;

/** Arbitrary constant shared by every MergePilot process. */
const MIGRATION_LOCK_ID = 7_406_311;

export interface RunMigrationsOptions {
  migrationsDir?: string;
}

function resolveDefaultMigrationsDir(): string {
  const metaDir = fileURLToPath(new URL('../../migrations', import.meta.url));
  if (existsSync(metaDir)) {
    return metaDir;
  }
  const appDir = join(process.cwd(), 'apps', 'app', 'migrations');
  if (existsSync(appDir)) {
    return appDir;
  }
  const cwdDir = join(process.cwd(), 'migrations');
  if (existsSync(cwdDir)) {
    return cwdDir;
  }
  return metaDir;
}

export async function runMigrations(
  client: MigrationClient,
  options?: RunMigrationsOptions,
): Promise<string[]> {
  const targetDir = options?.migrationsDir ?? resolveDefaultMigrationsDir();

  const isConnectable = (
    c: MigrationClient,
  ): c is ConnectableClient => 'connect' in c && typeof c.connect === 'function';

  let conn: QueryableClient & { release?: () => void };
  let shouldRelease = false;

  if (isConnectable(client)) {
    conn = await client.connect();
    shouldRelease = typeof conn.release === 'function';
  } else {
    conn = client;
  }

  // The web and worker containers may start together; serialise migrations across processes.
  await conn.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID});`);
  try {
    const initSql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `;

    if (typeof conn.exec === 'function') {
      await conn.exec(initSql);
    } else {
      await conn.query(initSql);
    }

    const res = await conn.query<{ name: string }>(
      'SELECT name FROM schema_migrations;',
    );
    const appliedSet = new Set(res.rows.map((row) => row.name));

    const files = await readdir(targetDir);
    const sqlFiles = files
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const appliedThisRun: string[] = [];

    for (const file of sqlFiles) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = join(targetDir, file);
      const sqlContent = await readFile(filePath, 'utf-8');

      if (typeof conn.exec === 'function') {
        await conn.exec('BEGIN;');
        try {
          await conn.exec(sqlContent);
          await conn.query(
            'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now());',
            [file],
          );
          await conn.exec('COMMIT;');
        } catch (err) {
          await conn.exec('ROLLBACK;');
          throw err;
        }
      } else {
        await conn.query('BEGIN;');
        try {
          await conn.query(sqlContent);
          await conn.query(
            'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now());',
            [file],
          );
          await conn.query('COMMIT;');
        } catch (err) {
          await conn.query('ROLLBACK;');
          throw err;
        }
      }

      appliedThisRun.push(file);
    }

    return appliedThisRun;
  } finally {
    await conn.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID});`).catch(() => undefined);
    if (shouldRelease && typeof conn.release === 'function') {
      conn.release();
    }
  }
}
