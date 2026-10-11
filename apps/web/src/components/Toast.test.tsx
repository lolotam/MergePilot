import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { ToastProvider, useToast } from './Toast.js';

function TestTrigger() {
  const { showToast } = useToast();
  return (
    <div>
      <button type="button" onClick={() => showToast('Success msg', 'success')}>
        Show Success
      </button>
      <button type="button" onClick={() => showToast('Error msg', 'error')}>
        Show Error
      </button>
    </div>
  );
}

describe('Toast component', () => {
  it('renders and dismisses toasts', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TestTrigger />
      </ToastProvider>,
    );

    await user.click(screen.getByText('Show Success'));
    expect(screen.getByText('Success msg')).toBeDefined();

    await user.click(screen.getByText('Show Error'));
    expect(screen.getByText('Error msg')).toBeDefined();

    // Dismiss button
    const closeButtons = screen.getAllByRole('button', { name: /Close notification/i });
    expect(closeButtons.length).toBe(2);

    await user.click(closeButtons[0]!);
    expect(screen.queryByText('Success msg')).toBeNull();
  });
});
