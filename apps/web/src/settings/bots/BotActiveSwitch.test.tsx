import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../../i18n/context.js';
import { BotActiveSwitch } from './BotLogo.js';

/** A parent that saves like the real ones: busy while the save runs, then follows the saved value. */
function Harness({ save }: { save: (next: boolean) => Promise<void> }) {
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <I18nProvider initialLanguage="en">
      <BotActiveSwitch
        checked={saved}
        disabled={busy}
        onChange={(next) => {
          setBusy(true);
          save(next)
            .then(() => setSaved(next))
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}
      />
    </I18nProvider>
  );
}

describe('BotActiveSwitch thumb', () => {
  const user = userEvent.setup();

  it('moves at once while the save is still running, and stays after it succeeds', async () => {
    let finish!: () => void;
    render(<Harness save={() => new Promise<void>((resolve) => (finish = resolve))} />);
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.firstElementChild?.classList.contains('translate-x-4')).toBe(false);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    finish();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('slides back when the save fails', async () => {
    render(<Harness save={() => Promise.reject(new Error('nope'))} />);
    const toggle = screen.getByRole('switch');
    await user.click(toggle);
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.firstElementChild?.classList.contains('translate-x-4')).toBe(true);
  });
});
