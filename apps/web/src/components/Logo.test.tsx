import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Logo } from './Logo.js';

describe('Logo Component', () => {
  it('renders mark SVG with dir="ltr"', () => {
    const { container } = render(React.createElement(Logo, null));
    const logoWrapper = container.firstElementChild as HTMLElement;
    expect(logoWrapper.getAttribute('dir')).toBe('ltr');

    const svg = container.querySelector('svg');
    expect(svg).toBeDefined();
    expect(svg?.getAttribute('viewBox')).toBe('90 74 1090 1090');

    const paths = container.querySelectorAll('svg path');
    expect(paths.length).toBe(2);
  });

  it('renders wordmark with Merge and Pilot by default', () => {
    render(React.createElement(Logo, null));
    expect(screen.getByText('Merge')).toBeDefined();
    expect(screen.getByText('Pilot')).toBeDefined();
  });

  it('hides wordmark when showWordmark is false', () => {
    render(React.createElement(Logo, { showWordmark: false }));
    expect(screen.queryByText('Merge')).toBeNull();
    expect(screen.queryByText('Pilot')).toBeNull();
  });

  it('applies sizing classes correctly', () => {
    const { container: smContainer } = render(React.createElement(Logo, { size: 'sm' }));
    expect(smContainer.querySelector('svg')?.classList.contains('w-6')).toBe(true);

    const { container: lgContainer } = render(React.createElement(Logo, { size: 'lg' }));
    expect(lgContainer.querySelector('svg')?.classList.contains('w-10')).toBe(true);
  });
});
