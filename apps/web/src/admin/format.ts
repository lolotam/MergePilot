import type { Language } from '../i18n/context.js';

function locale(language: Language): string {
  return language === 'ar' ? 'ar-EG' : 'en-US';
}

export function formatCount(value: number, language: Language): string {
  return new Intl.NumberFormat(locale(language)).format(value);
}

export function formatUsd(value: number | null, language: Language): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(locale(language), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatDateTime(value: string | null, language: Language): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
