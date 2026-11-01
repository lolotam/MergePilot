import { describe, expect, it } from 'vitest';
import {
  WEB_SCAN_JOB_NAME,
  WEB_SCAN_QUEUE_NAME,
  WEB_SCAN_TICK_EVERY_MS,
  WEB_SCAN_TICK_JOB_NAME,
  scanJobId,
} from './queue.js';

describe('the queue of the website scanner', () => {
  it('has its own queue, its own job names and a 15-minute tick', () => {
    expect(WEB_SCAN_QUEUE_NAME).toBe('web-scan');
    expect(WEB_SCAN_JOB_NAME).toBe('web-scan-run');
    expect(WEB_SCAN_TICK_JOB_NAME).toBe('web-scan-tick');
    expect(WEB_SCAN_TICK_EVERY_MS).toBe(15 * 60 * 1000);
  });
});

describe('the BullMQ job id of a scan', () => {
  it('is the durable scan id', () => {
    expect(scanJobId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
  });

  it('is stable, so a retry produces the same job and never a second scan', () => {
    const scanId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(scanJobId(scanId)).toBe(scanJobId(scanId));
  });

  it('keeps a scan id that BullMQ would reject apart from every other one', () => {
    const first = scanJobId('scan:one');
    const second = scanJobId('scan:two');
    expect(first).not.toBe(second);
    expect(first).toBe(scanJobId('scan:one'));
    // BullMQ job ids must not contain a colon.
    expect(first).not.toContain(':');
  });
});
