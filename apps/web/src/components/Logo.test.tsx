import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { Logo } from './Logo.js';

describe('Logo Component', () => {
  it('renders the original wordmark artwork for light and dark mode, always LTR', () => {
    const { container } = render(React.createElement(Logo, null));
    expect((container.firstElementChild as HTMLElement).getAttribute('dir')).toBe('ltr');
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute('src')).toBe('/brand/logo.png');
    expect(imgs[0]?.getAttribute('alt')).toBe('MergePilot');
    const source = container.querySelector('source');
    expect(source?.getAttribute('srcset')).toBe('/brand/logo-dark.png');
    expect(source?.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
  });

  it('renders only the mark when showWordmark is false', () => {
    const { container } = render(React.createElement(Logo, { showWordmark: false }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/mark.png');
    expect(container.querySelector('source')?.getAttribute('srcset')).toBe('/brand/mark-dark.png');
  });

  it('applies sizing classes', () => {
    const { container: sm } = render(React.createElement(Logo, { size: 'sm' }));
    expect(sm.querySelector('img')?.classList.contains('h-5')).toBe(true);
    const { container: lg } = render(React.createElement(Logo, { size: 'lg' }));
    expect(lg.querySelector('img')?.classList.contains('sm:h-11')).toBe(true);
  });
});
