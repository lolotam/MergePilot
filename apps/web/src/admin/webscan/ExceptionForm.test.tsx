import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { ExceptionForm } from './ExceptionForm.js';
import { occurrenceFixture } from './webscan-test-utils.js';

describe('the form of an exception', () => {
  it('keeps the error of the reason while the reason holds spaces only', async () => {
    let submitted = 0;
    const user = userEvent.setup();
    renderWithProviders(
      <ExceptionForm
        occurrences={[occurrenceFixture]}
        onSubmit={() => {
          submitted += 1;
        }}
        onCancel={() => {}}
      />,
    );

    const reason = screen.getByLabelText('Reason');
    await user.click(screen.getByRole('button', { name: 'Add an exception' }));

    // The reason is required: the submission is refused.
    expect(await screen.findByText('The reason is required.')).toBeTruthy();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(submitted).toBe(0);

    // Spaces are not a reason: the submission refuses them as well, so the
    // error stays where it is.
    await user.type(reason, '   ');
    expect(screen.getByText('The reason is required.')).toBeTruthy();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(submitted).toBe(0);

    // A reason the administrator wrote clears the error.
    await user.type(reason, 'The header is set by the CDN.');
    expect(screen.queryByText('The reason is required.')).toBeNull();
    expect(reason.hasAttribute('aria-invalid')).toBe(false);
  });
});
