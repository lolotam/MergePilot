import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { I18nProvider } from '../i18n/context.js';
import { RunGroupRows } from './RunGroupRows.js';
import { makeGroup, makeRun } from './runs-test-utils.js';
import { repoColor } from './repo-colors.js';

it('opens main details independently of expansion, selection, retry and nested keyboard events', () => {
  const onToggle = vi.fn();
  const onOpenRun = vi.fn();
  const onSelect = vi.fn();
  const onRetry = vi.fn();
  const group = makeGroup([
    makeRun({ id: 'extra', botSlot: 2, botName: 'Extra', headSha: 'head' }),
    makeRun({ id: 'main', botSlot: 1, botName: 'Main', headSha: 'head', status: 'failed' }),
  ]);
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><I18nProvider initialLanguage="en"><table><tbody><RunGroupRows group={group} number={1} color={repoColor(group.repoFullName)} shortRepo expanded onToggle={onToggle} onOpenRun={onOpenRun} onSelect={onSelect} onRetry={onRetry} selected={new Set()} canDelete isMember={false} retryingId={undefined} /></tbody></table></I18nProvider></MemoryRouter></QueryClientProvider>);
  const parent = screen.getByTestId('run-group-row');
  expect(parent.getAttribute('role')).toBe('row');
  expect(screen.getAllByText('Main')).toHaveLength(1);
  expect(screen.getAllByTestId('run-sub-row')).toHaveLength(1);
  const details = within(parent).getByRole('button', { name: 'Open review details for Main' });
  details.focus();
  expect(document.activeElement).toBe(details);
  // Native buttons retain their Enter/Space default activation; the row must not intercept it.
  for (const key of ['Enter', ' ']) expect(fireEvent.keyDown(details, { key })).toBe(true);
  fireEvent.click(details);
  expect(onOpenRun).toHaveBeenCalledExactlyOnceWith('main');
  expect(onToggle).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
  const select = within(parent).getByRole('checkbox');
  expect(fireEvent.keyDown(select, { key: ' ' })).toBe(true);
  fireEvent.click(select);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(['extra', 'main'], true);
  const retry = within(parent).getByRole('button', { name: 'Retry' });
  expect(fireEvent.keyDown(retry, { key: 'Enter' })).toBe(true);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledExactlyOnceWith('main');
  expect(onToggle).not.toHaveBeenCalled();
  const collapse = within(parent).getByRole('button', { name: 'Hide the runs of acme/backend#1' });
  expect(fireEvent.keyDown(collapse, { key: 'Enter' })).toBe(true);
  fireEvent.click(collapse);
  expect(onToggle).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(parent, { key: 'Enter' });
  expect(onToggle).toHaveBeenCalledTimes(2);
  expect(onOpenRun).toHaveBeenCalledTimes(1);
});
