import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { PrivacyPage } from './PrivacyPage.js';
import { TermsPage } from './TermsPage.js';
import { I18nProvider } from '../i18n/context.js';
import { SUPPORT_EMAIL, GOVERNING_LAW } from '../config/site.js';

describe('Legal Pages - Privacy and Terms', () => {
  const renderWithLang = (component: React.ReactElement, lang: 'ar' | 'en' = 'ar') =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: lang },
        React.createElement(MemoryRouter, null, component),
      ),
    );

  describe('PrivacyPage', () => {
    it('renders in Arabic with table of contents and last updated date', () => {
      renderWithLang(React.createElement(PrivacyPage, null), 'ar');
      expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      expect(screen.getByText(/2026-10-12/)).toBeDefined();
      expect(screen.getByText(/جدول المحتويات|المحتويات/i)).toBeDefined();
    });

    it('renders in English with table of contents', () => {
      renderWithLang(React.createElement(PrivacyPage, null), 'en');
      expect(screen.getByRole('heading', { level: 1, name: /Privacy Policy/i })).toBeDefined();
      expect(screen.getByText(/2026-10-12/)).toBeDefined();
      expect(screen.getByText(/Table of Contents/i)).toBeDefined();
    });

    it('contains Google API Limited Use statement and URL in Arabic and English', () => {
      const { unmount } = renderWithLang(React.createElement(PrivacyPage, null), 'ar');
      const googleLinkAr = screen.getByRole('link', {
        name: /https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy/i,
      });
      expect(googleLinkAr.getAttribute('href')).toBe('https://developers.google.com/terms/api-services-user-data-policy');
      expect(screen.getAllByText(/Limited Use|الاستخدام المحدود/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(new RegExp(SUPPORT_EMAIL)).length).toBeGreaterThanOrEqual(1);

      unmount();

      renderWithLang(React.createElement(PrivacyPage, null), 'en');
      const googleLinkEn = screen.getByRole('link', {
        name: /https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy/i,
      });
      expect(googleLinkEn.getAttribute('href')).toBe('https://developers.google.com/terms/api-services-user-data-policy');
      expect(screen.getAllByText(/Limited Use/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(new RegExp(SUPPORT_EMAIL)).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('TermsPage', () => {
    it('renders in Arabic and includes governing law and date', () => {
      renderWithLang(React.createElement(TermsPage, null), 'ar');
      expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      expect(screen.getByText(/2026-10-12/)).toBeDefined();
      expect(screen.getByText(new RegExp(GOVERNING_LAW))).toBeDefined();
    });

    it('renders in English and includes governing law', () => {
      renderWithLang(React.createElement(TermsPage, null), 'en');
      expect(screen.getByRole('heading', { level: 1, name: /Terms of Service/i })).toBeDefined();
      expect(screen.getByText(/2026-10-12/)).toBeDefined();
      expect(screen.getByText(new RegExp(GOVERNING_LAW))).toBeDefined();
    });
  });
});
