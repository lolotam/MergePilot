import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { ar, type I18nKey } from './ar.js';
import { en } from './en.js';

export type Language = 'ar' | 'en';

export interface I18nContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  toggleLanguage: () => void;
  dir: 'rtl' | 'ltr';
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const dictionaries = { ar, en };

export interface I18nProviderProps {
  children?: ReactNode;
  initialLanguage?: Language;
}

export function I18nProvider({ children, initialLanguage = 'ar' }: I18nProviderProps) {
  const [language, setLanguage] = useState<Language>(initialLanguage);

  const dir: 'rtl' | 'ltr' = language === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('dir', dir);
      document.documentElement.setAttribute('lang', language);
    }
  }, [language, dir]);

  const toggleLanguage = () => {
    setLanguage((prev) => (prev === 'ar' ? 'en' : 'ar'));
  };

  const t = (key: I18nKey, params?: Record<string, string | number>): string => {
    const dict = dictionaries[language];
    let text = dict[key] ?? dictionaries.ar[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, toggleLanguage, dir, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
}
