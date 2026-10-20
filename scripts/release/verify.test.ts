import { describe, expect, it } from 'vitest';
import { type ContainerSnapshot, type ExpectedRelease, verifyContainers, verifyHealthResponse } from './verify.ts';

const NEW_REF = 'ghcr.io/lolotam/mergepilot:new';
const OLD_REF = 'ghcr.io/lolotam/mergepilot:old';
const NEW_SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);

const container = (service: string, image: string, sha: string): ContainerSnapshot => ({
  service,
  image,
  revision: sha,
  state: service === 'migrate' ? 'exited' : 'running',
  exitCode: 0,
  health: service === 'migrate' ? null : 'healthy',
});

const containers = (web: { image: string; sha: string }, worker: { image: string; sha: string }): ContainerSnapshot[] => [
  container('migrate', web.image, web.sha),
  { service: 'postgres', image: 'postgres:17-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  { service: 'redis', image: 'redis:7-alpine', revision: null, state: 'running', exitCode: 0, health: 'healthy' },
  container('web', web.image, web.sha),
  container('worker', worker.image, worker.sha),
];

const webPhase: ExpectedRelease = { web: { imageRef: NEW_REF, sourceSha: NEW_SHA }, worker: { imageRef: OLD_REF, sourceSha: OLD_SHA } };
const fullRelease: ExpectedRelease = { web: { imageRef: NEW_REF, sourceSha: NEW_SHA }, worker: { imageRef: NEW_REF, sourceSha: NEW_SHA } };

describe('verifyContainers', () => {
  it('accepts a release where every service runs the expected image', () => {
    expect(verifyContainers(containers({ image: NEW_REF, sha: NEW_SHA }, { image: NEW_REF, sha: NEW_SHA }), fullRelease)).toEqual([]);
  });

  it('accepts the web phase: the web on the new image and the worker on the old one', () => {
    expect(verifyContainers(containers({ image: NEW_REF, sha: NEW_SHA }, { image: OLD_REF, sha: OLD_SHA }), webPhase)).toEqual([]);
  });

  it('fails when the worker runs another image than the one expected', () => {
    const problems = verifyContainers(containers({ image: NEW_REF, sha: NEW_SHA }, { image: OLD_REF, sha: OLD_SHA }), fullRelease);
    expect(problems).toContain(`worker runs ${OLD_REF}, expected ${NEW_REF}`);
    expect(problems).toContain(`worker image revision is ${OLD_SHA}, expected ${NEW_SHA}`);
  });

  it('checks only the image of a worker whose commit the record does not know', () => {
    const unknownWorker: ExpectedRelease = { ...webPhase, worker: { imageRef: OLD_REF, sourceSha: null } };
    expect(verifyContainers(containers({ image: NEW_REF, sha: NEW_SHA }, { image: OLD_REF, sha: OLD_SHA }), unknownWorker)).toEqual([]);
    const wrongImage = verifyContainers(containers({ image: NEW_REF, sha: NEW_SHA }, { image: NEW_REF, sha: NEW_SHA }), unknownWorker);
    expect(wrongImage).toEqual([`worker runs ${NEW_REF}, expected ${OLD_REF}`]);
  });

  it('fails when the web runs another image than the one expected', () => {
    const problems = verifyContainers(containers({ image: OLD_REF, sha: OLD_SHA }, { image: NEW_REF, sha: NEW_SHA }), webPhase);
    expect(problems).toContain(`web runs ${OLD_REF}, expected ${NEW_REF}`);
  });

  it('fails when a service is missing, not running or unhealthy', () => {
    const without = containers({ image: NEW_REF, sha: NEW_SHA }, { image: NEW_REF, sha: NEW_SHA }).filter((c) => c.service !== 'worker');
    expect(verifyContainers(without, fullRelease)).toContain('worker container not found');
    const unhealthy = containers({ image: NEW_REF, sha: NEW_SHA }, { image: NEW_REF, sha: NEW_SHA }).map((c) => (c.service === 'web' ? { ...c, health: 'unhealthy' } : c));
    expect(verifyContainers(unhealthy, fullRelease)).toContain('web health is unhealthy, expected healthy');
  });

  it('fails when the one-shot migration did not exit cleanly', () => {
    const failed = containers({ image: NEW_REF, sha: NEW_SHA }, { image: NEW_REF, sha: NEW_SHA }).map((c) => (c.service === 'migrate' ? { ...c, exitCode: 1 } : c));
    expect(verifyContainers(failed, fullRelease)).toContain('migrate exited with code 1');
  });
});

describe('verifyHealthResponse', () => {
  it('accepts only a 200 with exactly {"ok":true}', () => {
    expect(verifyHealthResponse(200, '{"ok":true}')).toEqual([]);
    expect(verifyHealthResponse(502, 'Bad Gateway')).toEqual(['GET /health answered 502']);
    expect(verifyHealthResponse(200, '{"ok":false}')).toHaveLength(1);
    expect(verifyHealthResponse(200, 'not json')).toHaveLength(1);
  });
});
