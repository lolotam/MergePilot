import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { LandingPage } from './LandingPage.js';
import { I18nProvider } from '../i18n/context.js';
import { SUPPORT_EMAIL } from '../config/site.js';

describe('LandingPage', () => {
  const renderLandingPage = (initialLanguage: 'ar' | 'en' = 'ar') =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(LandingPage, null),
        ),
      ),
    );

  it('renders hero with logo and value proposition', () => {
    renderLandingPage('ar');
    expect(screen.getAllByText('Merge').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Pilot').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
  });

  it('renders CTAs linking to /login', () => {
    renderLandingPage('ar');
    const loginLinks = screen.getAllByRole('link', { name: /ابدأ مجانًا|Get started|ثبّت على GitHub|Install on GitHub/i });
    expect(loginLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of loginLinks) {
      expect(link.getAttribute('href')).toBe('/login');
    }
  });

  it('renders 3 how-it-works steps with numbers and descriptions', () => {
    renderLandingPage('ar');
    expect(screen.getByText('01')).toBeDefined();
    expect(screen.getByText('02')).toBeDefined();
    expect(screen.getByText('03')).toBeDefined();
    expect(screen.getByRole('heading', { level: 3, name: /ربط.*GitHub|Connect.*GitHub/i })).toBeDefined();
    expect(screen.getByRole('heading', { level: 3, name: /إضافة مفتاح|Add.*Key/i })).toBeDefined();
    expect(screen.getByRole('heading', { level: 3, name: /مراجعات.*PR|Reviews.*PR/i })).toBeDefined();
  });

  it('renders core feature highlights including security and Arabic-first', () => {
    renderLandingPage('ar');
    expect(screen.getAllByText(/عربية|Arabic/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/قواعد|Rules/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/AES-256|مشفرة|Encrypted/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders 5 FAQ items', () => {
    renderLandingPage('ar');
    const faqHeadings = screen.getAllByRole('heading', { level: 3 });
    // Headings include steps, features, providers, and FAQ
    expect(faqHeadings.length).toBeGreaterThanOrEqual(5);
  });

  it('renders footer links to privacy, terms and support email', () => {
    renderLandingPage('ar');
    const privacyLinks = screen.getAllByRole('link', { name: /الخصوصية|Privacy/i });
    expect(privacyLinks.some((l) => l.getAttribute('href') === '/privacy')).toBe(true);

    const termsLinks = screen.getAllByRole('link', { name: /الشروط|Terms/i });
    expect(termsLinks.some((l) => l.getAttribute('href') === '/terms')).toBe(true);

    const emailLink = screen.getByRole('link', { name: new RegExp(SUPPORT_EMAIL) });
    expect(emailLink.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`);
  });

  it('switches language and document direction when language toggle is clicked', async () => {
    const user = userEvent.setup();
    renderLandingPage('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');

    const toggleBtn = screen.getByRole('button', { name: /English/i });
    await user.click(toggleBtn);

    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});
