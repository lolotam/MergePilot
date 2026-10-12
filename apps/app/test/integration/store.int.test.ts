import { describe, it } from 'vitest';
import { describeStoreContract, STORE_CONTRACT_WORKSPACES } from '../../src/db/store-contract.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  type TestPostgresContext,
} from './test-helper.js';

if (!hasIntegrationEnv) {
  describe.skip('store contract on real Postgres (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  let currentContext: TestPostgresContext | null = null;

  describeStoreContract(
    'PgStore on real Postgres',
    async () => {
      currentContext = await createMigratedTestDb(INTEGRATION_DATABASE_URL, {
        workspaces: STORE_CONTRACT_WORKSPACES,
      });
      return currentContext.store;
    },
    async () => {
      if (currentContext) {
        await currentContext.close();
        currentContext = null;
      }
    },
  );
}
