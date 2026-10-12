/** One model a provider offers, as shown in a model picker. */
export interface CatalogModel {
  id: string;
  /** Display name; the id when the provider gives none. */
  name: string;
  /** Thinking efforts the model takes, e.g. `['off', 'low', 'medium', 'high']`; empty when none. */
  efforts: string[];
  defaultEffort?: string;
  contextWindow?: number;
}

/** Sorts by id and keeps the first entry of each id. */
export function sortUnique(models: readonly CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
