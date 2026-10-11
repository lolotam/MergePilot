import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Modal } from './Modal.js';

describe('Modal component', () => {
  it('renders modal when open and closes on ESC or close button', async () => {
    const handleClose = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <Modal isOpen={false} onClose={handleClose} title="Test Modal">
        <p>Modal content</p>
      </Modal>,
    );

    expect(screen.queryByText('Test Modal')).toBeNull();

    rerender(
      <Modal isOpen={true} onClose={handleClose} title="Test Modal">
        <p>Modal content</p>
      </Modal>,
    );

    expect(screen.getByText('Test Modal')).toBeDefined();
    expect(screen.getByText('Modal content')).toBeDefined();

    const closeBtn = screen.getByRole('button', { name: /Close/i });
    await user.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(handleClose).toHaveBeenCalledTimes(2);
  });
});
