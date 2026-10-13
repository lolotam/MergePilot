import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ADMIN_SEARCH_DEBOUNCE_MS, useDebouncedValue } from './hooks.js';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only passes a value on once it stopped changing for the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: '' } });
    for (const partial of ['S', 'SA', 'SAR', 'SARA', 'SARA@']) {
      rerender({ value: partial });
      act(() => {
        vi.advanceTimersByTime(ADMIN_SEARCH_DEBOUNCE_MS - 1);
      });
      // Each keystroke restarts the wait: the partial terms never come through.
      expect(result.current).toBe('');
    }
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('SARA@');
  });
});
