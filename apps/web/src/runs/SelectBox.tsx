import { useEffect, useRef } from 'react';

interface SelectBoxProps {
  checked: boolean;
  /** Some but not all of the rows it stands for are selected. */
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  title?: string | undefined;
  onChange: (checked: boolean) => void;
}

/** Row / group / page selection checkbox; clicks never reach the row (no navigation, no expand). */
export function SelectBox({ checked, indeterminate = false, disabled = false, label, title, onChange }: SelectBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={title}
      checked={checked}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
      className="w-3.5 h-3.5 rounded border-ink-300 dark:border-ink-600 accent-brand-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}
