import type { PriceOverrideDto, PricesResponse } from '@mergepilot/app/contract';
import type { I18nKey } from '../i18n/ar.js';
import type { Language } from '../i18n/context.js';

export type PricedModel = PricesResponse['models'][number];

/** A price in USD per million tokens: always Latin digits, 2 to 4 decimals ($3.00, $0.042). */
export function formatPerMTok(value: number): string {
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)}`;
}

const SOURCE_KEYS: Record<string, I18nKey> = {
  'catalog:openrouter': 'pricesSourceOpenrouter',
  'catalog:vercel': 'pricesSourceVercel',
  'catalog:models.dev': 'pricesSourceModelsDev',
  override: 'pricesSourceOverride',
  repo: 'pricesSourceRepo',
  static: 'pricesSourceStatic',
  unknown: 'pricesSourceUnknown',
};

/** The badge label key of a pricing source; undefined for a source this build does not know. */
export function priceSourceKey(source: string): I18nKey | undefined {
  return SOURCE_KEYS[source];
}

const RUN_SOURCE_KEYS: Record<string, I18nKey> = {
  'catalog:openrouter': 'runPriceOpenrouter',
  'catalog:vercel': 'runPriceVercel',
  'catalog:models.dev': 'runPriceModelsDev',
  override: 'runPriceOverride',
  repo: 'runPriceRepo',
  static: 'runPriceStatic',
  unknown: 'runPriceUnknown',
};

/** The "· OpenRouter price" text of a run's `result.pricing.source`. */
export function runPriceLabel(source: string, t: (key: I18nKey, params?: Record<string, string>) => string): string {
  const key = RUN_SOURCE_KEYS[source];
  return key ? t(key) : t('runPriceOther', { source: source.replace(/^catalog:/, '') });
}

/** The badge label of each model row's role; fallbacks are numbered within their own chain. */
export function roleLabels(models: readonly PricedModel[], t: (key: I18nKey, params?: Record<string, string>) => string): string[] {
  let fallback = 0;
  let judgeFallback = 0;
  return models.map((m) => {
    switch (m.role) {
      case 'primary':
        return t('pricesRolePrimary');
      case 'heavy':
        return t('pricesRoleHeavy');
      case 'fallback':
        fallback += 1;
        return t('pricesRoleFallback', { n: String(fallback) });
      case 'judge':
        return t('pricesRoleJudge');
      case 'judge-fallback':
        judgeFallback += 1;
        return t('pricesRoleJudgeFallback', { n: String(judgeFallback) });
    }
  });
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 hours ago" / «منذ 3 ساعات». */
export function formatRelative(iso: string, language: Language, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language === 'ar' ? 'ar-EG' : 'en-US', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

const sameKey = (o: PriceOverrideDto, provider: string, model: string) => o.provider === provider && o.model === model;
const sameKeyIgnoringCase = (o: PriceOverrideDto, provider: string, model: string) =>
  o.provider.toLowerCase() === provider.toLowerCase() && o.model.toLowerCase() === model.toLowerCase();

/** The index of the override the server applies to this model: exact first, then case-insensitive. */
function overrideIndex(list: readonly PriceOverrideDto[], provider: string, model: string): number {
  const exact = list.findIndex((o) => sameKey(o, provider, model));
  return exact >= 0 ? exact : list.findIndex((o) => sameKeyIgnoringCase(o, provider, model));
}

/** The whole override list with this model's entry replaced in place, or appended. */
export function upsertOverride(list: readonly PriceOverrideDto[], entry: PriceOverrideDto): PriceOverrideDto[] {
  const index = overrideIndex(list, entry.provider, entry.model);
  if (index < 0) return [...list, entry];
  return list.map((o, i) => (i === index ? entry : o));
}

/** The whole override list without this model's entry. */
export function removeOverride(list: readonly PriceOverrideDto[], provider: string, model: string): PriceOverrideDto[] {
  const index = overrideIndex(list, provider, model);
  return index < 0 ? [...list] : list.filter((_, i) => i !== index);
}
