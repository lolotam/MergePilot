import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * The dialog of a decision that is on its way.
 *
 * A request that is running cannot be dismissed: the dialog stays open until
 * the server answers, so the administrator never closes a decision that is
 * already running.
 */
describe('the confirmation dialog of the website scan', () => {
  it('cannot be dismissed while the request it confirms is on its way', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ConfirmDialog
        isOpen
        title="Remove the site"
        confirmLabel="Remove"
        isPending
        onConfirm={() => {}}
        onClose={onClose}
      />,
    );

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await user.click(cancel);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is dismissed with the escape key and with the cancel button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ConfirmDialog
        isOpen
        title="Remove the site"
        confirmLabel="Remove"
        onConfirm={() => {}}
        onClose={onClose}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
