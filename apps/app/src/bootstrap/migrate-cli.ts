import { Pool } from 'pg';
import { runMigrations } from '../db/index.js';

export async function runMigrateCli(
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  // Migrations need only the database; requiring every app secret here would make the
  // one-shot migrate container fail for no reason.
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  if (databaseUrl.startsWith('memory:')) {
    console.log('Database URL is in-memory; migrations skipped.');
    return [];
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const applied = await runMigrations(pool);
    console.log(`Applied ${applied.length} migration(s):`, applied);
    return applied;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runMigrateCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exit(1);
  });
}
