/**
 * The request-to-store adapters of the scanner routes (ADR-0052).
 *
 * The HTTP contract types an optional field as `field?: T | undefined`, while the
 * store types declare it as `field?: T` under `exactOptionalPropertyTypes`. A field
 * that was not submitted must therefore be absent from a store input, never present
 * with an empty value: these helpers copy the defined fields only.
 */

import type { ScanLimits } from '@mergepilot/webscan';
import type {
  WebScanLimitsPatch,
  WebScanSchedule as WebScanScheduleRequest,
} from '../api/contract-webscan.js';
import type { WebScanSchedule } from '../webscan/types.js';

/**
 * The fields of `T` without the `undefined` of a field that may carry one.
 *
 * A field that may be undefined becomes optional and loses the `undefined` of its
 * type; a field that always carries a value stays required.
 */
export type DefinedFields<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: Exclude<T[K], undefined>;
};

/**
 * Copies the fields of `source` whose value is not `undefined`; the others stay
 * absent.
 *
 * The store reads an absent field as a field that was not submitted, so a field
 * that carries no value never reaches it as an empty one. A `null` is a value of
 * its own and is copied: the store reads it as an explicit clearing, while an
 * absent field leaves the stored value alone.
 */
export function definedFields<T extends object>(source: T): DefinedFields<T> {
  const entries: Array<[string, unknown]> = Object.entries(source);
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as DefinedFields<T>;
}

/** The limits of a request, as the store's shape: the fields it carries only. */
export function toStoreLimits(limits: WebScanLimitsPatch): Partial<ScanLimits> {
  return definedFields(limits);
}

/**
 * The schedule of a request, as the store's shape.
 *
 * A null schedule means no schedule: the contract allows one on a registration,
 * and the store reads an absent schedule as none.
 */
export function toStoreSchedule(
  schedule: WebScanScheduleRequest | null | undefined,
): WebScanSchedule | undefined {
  if (schedule === undefined || schedule === null) return undefined;
  return definedFields(schedule);
}
