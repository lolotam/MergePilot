import { useState } from 'react';
import type { PriceOverrideDto } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';
import type { PricedModel } from './price-format.js';

/** The contract's MAX_PRICE_PER_MTOK (the web never imports server runtime code). */
export const MAX_PRICE = 1000;

export type PriceFields = Omit<PriceOverrideDto, 'provider' | 'model'>;

type FieldName = 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok';

const FIELDS: Array<{ name: FieldName; label: I18nKey; required: boolean }> = [
  { name: 'inputPerMTok', label: 'pricesInputLabel', required: true },
  { name: 'outputPerMTok', label: 'pricesOutputLabel', required: true },
  { name: 'cacheReadPerMTok', label: 'pricesCacheReadLabel', required: false },
  { name: 'cacheWritePerMTok', label: 'pricesCacheWriteLabel', required: false },
];

const inputClass =
  'w-full px-2.5 py-1.5 text-xs rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:outline-hidden focus:ring-2 focus:ring-brand-500 disabled:opacity-60';

/** A price typed by the user, or undefined when it is not a number from 0 to MAX_PRICE. */
function parsePrice(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : undefined;
}

/** The typed prices, or null when one is missing or out of range. */
export function readPriceFields(values: Record<FieldName, string>): PriceFields | null {
  const input = parsePrice(values.inputPerMTok);
  const output = parsePrice(values.outputPerMTok);
  if (input === undefined || output === undefined) return null;
  const fields: PriceFields = { inputPerMTok: input, outputPerMTok: output };
  for (const name of ['cacheReadPerMTok', 'cacheWritePerMTok'] as const) {
    if (values[name].trim() === '') continue;
    const value = parsePrice(values[name]);
    if (value === undefined) return null;
    fields[name] = value;
  }
  return fields;
}

export interface PriceEditRowProps {
  model: PricedModel;
  colSpan: number;
  saving: boolean;
  /** The server's message after a failed save. */
  serverError: string | null;
  onSave: (fields: PriceFields) => void;
  onCancel: () => void;
}

/** The inline manual-price form under a model's row (admins and owners only). */
export function PriceEditRow({ model, colSpan, saving, serverError, onSave, onCancel }: PriceEditRowProps) {
  const { t } = useI18n();
  const start = (value: number | undefined) => (value === undefined ? '' : String(value));
  const [values, setValues] = useState<Record<FieldName, string>>({
    inputPerMTok: start(model.price?.inputPerMTok),
    outputPerMTok: start(model.price?.outputPerMTok),
    cacheReadPerMTok: start(model.price?.cacheReadPerMTok),
    cacheWritePerMTok: start(model.price?.cacheWritePerMTok),
  });
  const [invalid, setInvalid] = useState(false);
  const error = invalid ? t('pricesInvalid') : serverError;

  const save = () => {
    const fields = readPriceFields(values);
    setInvalid(fields === null);
    if (fields) onSave(fields);
  };

  return (
    <tr className="bg-ink-50/60 dark:bg-ink-950/30">
      <td colSpan={colSpan} className="py-3 px-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {FIELDS.map((field) => (
            <div key={field.name}>
              <label htmlFor={`price-${field.name}`} className="block text-[11px] font-semibold text-ink-600 dark:text-ink-300 mb-1">
                {t(field.label)}
              </label>
              <input
                id={`price-${field.name}`}
                type="number"
                inputMode="decimal"
                min={0}
                max={MAX_PRICE}
                step="any"
                dir="ltr"
                required={field.required}
                value={values[field.name]}
                disabled={saving}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                className={inputClass}
              />
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert" data-testid="price-edit-error" className="mt-2 text-[11px] text-red-700 dark:text-red-300 break-words">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3.5 py-1.5 rounded-full border border-ink-200 dark:border-ink-700 text-xs text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          >
            {t('save')}
          </button>
        </div>
      </td>
    </tr>
  );
}
