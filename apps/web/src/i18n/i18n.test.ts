import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { ar } from './ar.js';
import { en } from './en.js';
import { I18nProvider, useI18n } from './context.js';

describe('i18n keys and parity', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('every key exists in both languages with identical keys', () => {
    const arKeys = Object.keys(ar).sort();
    const enKeys = Object.keys(en).sort();

    expect(arKeys).toEqual(enKeys);
    expect(arKeys.length).toBeGreaterThan(30);

    for (const key of arKeys) {
      const typedKey = key as keyof typeof ar;
      expect(typeof ar[typedKey]).toBe('string');
      expect(typeof en[typedKey]).toBe('string');
      expect(ar[typedKey].trim().length).toBeGreaterThan(0);
      expect(en[typedKey].trim().length).toBeGreaterThan(0);
    }
  });

  it('sets RTL attribute for Arabic and LTR for English on documentElement', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, { initialLanguage: 'ar' }, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(result.current.language).toBe('ar');
    expect(result.current.dir).toBe('rtl');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');

    act(() => {
      result.current.setLanguage('en');
    });

    expect(result.current.language).toBe('en');
    expect(result.current.dir).toBe('ltr');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('correctly substitutes placeholder parameters', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, { initialLanguage: 'ar' }, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });
    const formatted = result.current.t('deleteKeyConfirm', { provider: 'Anthropic' });
    expect(formatted).toContain('Anthropic');
  });

  it('persists language selection in localStorage', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, null, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });

    act(() => {
      result.current.setLanguage('en');
    });

    expect(localStorage.getItem('mergepilot_lang')).toBe('en');

    act(() => {
      result.current.toggleLanguage();
    });

    expect(localStorage.getItem('mergepilot_lang')).toBe('ar');
  });

  it('opens in English by default when nothing is saved', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, null, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.language).toBe('en');
    expect(result.current.dir).toBe('ltr');
  });

  it('loads saved language from localStorage on initialization', () => {
    localStorage.setItem('mergepilot_lang', 'ar');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, null, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.language).toBe('ar');
    expect(result.current.dir).toBe('rtl');
  });

  it('gracefully handles localStorage failures without throwing', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(I18nProvider, { initialLanguage: 'ar' }, children)
    );

    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(() => {
      act(() => {
        result.current.setLanguage('en');
      });
    }).not.toThrow();

    expect(result.current.language).toBe('en');
    setItemSpy.mockRestore();
  });
});
