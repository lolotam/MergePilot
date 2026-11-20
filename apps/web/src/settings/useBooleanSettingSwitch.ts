import { useEffect, useRef, useState } from 'react';
import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';

export type BooleanSettingKey = 'mainBotActive' | 'botsEnabled';

/** A workspace setting that saves at once as a patch and restores the saved value on failure. */
export function useBooleanSettingSwitch(
  key: BooleanSettingKey,
  settings: Settings | null | undefined,
  onSave: (next: SettingsUpdate) => Promise<void>,
  blocked: boolean,
  failureText: string,
) {
  const saved = settings?.[key] ?? true;
  const [checked, setChecked] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
    setChecked(saved);
  }, [saved]);

  const toggle = async () => {
    if (!settings || blocked || busy) return;
    const shown = checked;
    const next = !shown;
    const current = {
      provider: settings.provider,
      model: settings.model,
      language: settings.language,
    };
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...current,
        [key]: next,
        base: { ...current, [key]: shown },
      });
      savedRef.current = next;
      setChecked(next);
    } catch (err) {
      setChecked(savedRef.current);
      setError(err instanceof Error && err.message ? err.message : failureText);
    } finally {
      setBusy(false);
    }
  };

  return {
    checked,
    busy,
    error,
    disabled: blocked || !settings || busy,
    toggle: () => void toggle(),
  };
}
