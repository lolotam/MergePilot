import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { Logo } from './Logo.js';

describe('Logo Component', () => {
  it('renders the original wordmark artwork for light and dark mode, always LTR', () => {
    const { container } = render(React.createElement(Logo, null));
    expect((container.firstElementChild as HTMLElement).getAttribute('dir')).toBe('ltr');
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual(['/brand/logo.png', '/brand/logo-dark.png']);
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBe('MergePilot');
    }
  });

  it('renders only the mark when showWordmark is false', () => {
    const { container } = render(React.createElement(Logo, { showWordmark: false }));
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual(['/brand/mark.png', '/brand/mark-dark.png']);
  });

  it('applies sizing classes', () => {
    const { container: sm } = render(React.createElement(Logo, { size: 'sm' }));
    expect(sm.querySelector('img')?.classList.contains('h-6')).toBe(true);
    const { container: lg } = render(React.createElement(Logo, { size: 'lg' }));
    expect(lg.querySelector('img')?.classList.contains('h-11')).toBe(true);
  });
});
