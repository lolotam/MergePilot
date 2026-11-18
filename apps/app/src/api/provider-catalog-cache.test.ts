import { afterEach, expect, it } from 'vitest';
import { beginCatalogRead, resetCatalogCache } from './provider-catalog-cache.js';

const models = [{ id: 'fixture', name: 'Fixture', efforts: [] }];
afterEach(resetCatalogCache);

it('rejects an ordinary read that outlives publication and eviction of a strict result', () => {
  const strict = beginCatalogRead('workspace:provider', 'revision', 'sync');
  const olderPicker = beginCatalogRead('workspace:provider', 'revision', 'ordinary');
  expect(strict.publish(models)).toEqual({ models });
  strict.finish();
  for (let i = 0; i < 1000; i++) {
    const other = beginCatalogRead(`other-${i}:provider`, 'revision', 'ordinary');
    other.publish(models);
    other.finish();
  }
  expect(olderPicker.publish(models)).toBe('catalog_superseded');
  olderPicker.finish();
  const newPicker = beginCatalogRead('workspace:provider', 'revision', 'ordinary');
  expect(newPicker.publish(models)).toEqual({ models });
  newPicker.finish();
});
