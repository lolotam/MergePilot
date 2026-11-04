import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { OffsetPager } from './OffsetPager.js';

describe('the pager of a list without a total', () => {
  it('shows nothing when the list has no row at all', () => {
    const { container } = renderWithProviders(
      <OffsetPager offset={0} limit={20} count={0} onChange={vi.fn()} />,
    );

    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the way back on an empty page that is not the first one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<OffsetPager offset={20} limit={20} count={0} onChange={onChange} />);

    const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    // There is no row to range over.
    expect(screen.queryByText(/From 21 to/)).toBeNull();

    await user.click(previous);
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
