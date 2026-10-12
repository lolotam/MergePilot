import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { Footer } from './Footer.js';
import { I18nProvider } from '../i18n/context.js';
import { SITE_NAME, SUPPORT_EMAIL } from '../config/site.js';

describe('Footer Component', () => {
  const renderFooter = () =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(Footer, null),
        ),
      ),
    );

  it('renders copyright and site name', () => {
    renderFooter();
    expect(screen.getByText(new RegExp(SITE_NAME))).toBeDefined();
    expect(screen.getByText(/©/)).toBeDefined();
  });

  it('renders links to /privacy and /terms', () => {
    renderFooter();
    const privacyLink = screen.getByRole('link', { name: /الخصوصية|Privacy/i });
    expect(privacyLink.getAttribute('href')).toBe('/privacy');

    const termsLink = screen.getByRole('link', { name: /الشروط|Terms/i });
    expect(termsLink.getAttribute('href')).toBe('/terms');
  });

  it('renders support email link from site config', () => {
    renderFooter();
    const emailLink = screen.getByRole('link', { name: new RegExp(SUPPORT_EMAIL) });
    expect(emailLink.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`);
  });
});
