import { afterEach, expect, it } from 'vitest';
import { beginCatalogRead, resetCatalogCache } from './provider-catalog-cache.js';

const models = [{ id: 'fixture', name: 'Fixture', efforts: [] }];
afterEach(resetCatalogCache);

it.each([false, true])('rejects an ordinary read pending when a strict result is evicted (strict published first: %s)', (strictFirst) => {
  const strict = beginCatalogRead('workspace:provider', 'revision', 'sync');
  const firstPicker = strictFirst ? undefined : beginCatalogRead('workspace:provider', 'revision', 'ordinary');
  expect(strict.publish(models)).toEqual({ models });
  strict.finish();
  const olderPicker = firstPicker ?? beginCatalogRead('workspace:provider', 'revision', 'ordinary');
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
