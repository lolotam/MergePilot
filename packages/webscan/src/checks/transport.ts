/**
 * The transport check (ADR-0052 section 3, check 3).
 *
 * The check answers two questions:
 *
 * - Does the site answer on port 80 without redirecting to HTTPS? One fixed
 *   root probe over cleartext decides it. The probe never carries the base
 *   path of the site, because a base path may hold a secret.
 * - Does an HTTPS page reference an HTTP asset? The assets are found
 *   structurally in the received page. A third party is never requested.
 *
 * A closed or unreachable cleartext port is a check-scoped outcome: it never
 * fails the scan and it never stops it. A refused port is a successful negative
 * only when the secure endpoint of the site was reached in the same run.
 */

import type { DefaultTreeAdapterTypes } from 'parse5';

import { isScanTransportError } from '../errors.js';
import type { CheckEvaluation, CheckEvaluationContext } from '../evaluation.js';
import { canonicalHostname, evaluateTransportProbe } from '../scope.js';
import type { OccurrenceFinding } from '../types.js';
import {
  attributeValue,
  buildFinding,
  coverageRow,
  decodeBody,
  htmlElements,
  safeLocationOf,
} from './shared.js';

/** The subject of the cleartext probe occurrence. */
const HTTP_ROOT_SUBJECT = 'http-root';

/** The subject of the mixed content occurrence. */
const MIXED_CONTENT_SUBJECT = 'http-assets';

/** One kind of asset a page can reference. */
interface AssetKind {
  readonly tag: string;
  readonly attribute: string;
  readonly kind: string;
}

/** The asset kinds the check looks at. */
const ASSET_KINDS: readonly AssetKind[] = [
  { tag: 'script', attribute: 'src', kind: 'script' },
  { tag: 'img', attribute: 'src', kind: 'image' },
  { tag: 'iframe', attribute: 'src', kind: 'frame' },
  { tag: 'frame', attribute: 'src', kind: 'frame' },
  { tag: 'audio', attribute: 'src', kind: 'media' },
  { tag: 'video', attribute: 'src', kind: 'media' },
  { tag: 'source', attribute: 'src', kind: 'media' },
  { tag: 'track', attribute: 'src', kind: 'media' },
  { tag: 'embed', attribute: 'src', kind: 'other' },
  { tag: 'object', attribute: 'data', kind: 'other' },
];

/** The asset kind of an element, or null when it references no asset. */
function assetKindOf(element: DefaultTreeAdapterTypes.Element): AssetKind | null {
  for (const asset of ASSET_KINDS) {
    if (asset.tag === element.tagName) {
      return asset;
    }
  }
  if (element.tagName !== 'link') {
    return null;
  }
  const rel = attributeValue(element, 'rel') ?? '';
  return rel.toLowerCase().includes('stylesheet')
    ? { tag: 'link', attribute: 'href', kind: 'stylesheet' }
    : null;
}

/**
 * The kinds of the HTTP assets a page references.
 *
 * The asset URLs are only read structurally: no third party is ever requested.
 */
function mixedAssetKinds(body: string, baseUrl: string): readonly string[] {
  const kinds = new Set<string>();
  for (const element of htmlElements(body)) {
    const asset = assetKindOf(element);
    if (asset === null) {
      continue;
    }
    const raw = attributeValue(element, asset.attribute);
    if (raw === null || raw === '') {
      continue;
    }
    try {
      if (new URL(raw, baseUrl).protocol === 'http:') {
        kinds.add(asset.kind);
      }
    } catch {
      // A URL that cannot be resolved references no asset.
    }
  }
  return [...kinds].sort();
}

/** Whether the secure endpoint of the site was reached in this run. */
function secureEndpointReached(context: CheckEvaluationContext): boolean {
  return context.targets.some((target) => target.destinationReached);
}

/** Whether a `Location` points at HTTPS. */
function redirectsToHttps(location: string, baseUrl: string): boolean {
  try {
    return new URL(location, baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The transport check of one scan.
 *
 * The cleartext probe is evaluated for the site, the mixed content check for
 * every page the scan received.
 */
export async function evaluateTransport(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    const findings: OccurrenceFinding[] = [];
    const evaluatedIssueIds: string[] = [];
    if (target.destinationReached) {
      evaluatedIssueIds.push('mixed-content');
      const kinds = mixedAssetKinds(decodeBody(target.body), target.finalUrl);
      if (kinds.length > 0) {
        findings.push(
          buildFinding({
            context,
            targetKey: target.targetKey,
            checkId: 'transport',
            issueId: 'mixed-content',
            subject: MIXED_CONTENT_SUBJECT,
            safeLocation: safeLocationOf(context, target.baselineUrl),
            validation: 'Confirmed',
            confidence: 'high',
            evidence: { scheme: 'http', asset_kinds: kinds.join(',') },
          }),
        );
      }
    }
    const result: CheckEvaluation = {
      coverage: coverageRow({
        targetKey: target.targetKey,
        checkId: 'transport',
        evaluatedIssueIds,
        outcome: 'checked',
        reason: undefined,
      }),
      findings,
    };
    results.push(result);
    context.emit([result]);
  }
  const probe = await evaluatePort80Probe(context);
  if (probe !== null) {
    results.push(probe);
    context.emit([probe]);
  }
  return results;
}

/**
 * The cleartext probe of the site.
 *
 * The probe is the root of the site over HTTP: no query, no fragment and no
 * base path.
 */
async function evaluatePort80Probe(
  context: CheckEvaluationContext,
): Promise<CheckEvaluation | null> {
  const host = canonicalHostname(context.scope.hostname);
  const probeUrl = `http://${host}/`;
  const targetKey = context.identity.identifyTarget(probeUrl);
  const decision = evaluateTransportProbe(context.scope, probeUrl);
  if (!decision.allowed) {
    return {
      coverage: coverageRow({
        targetKey,
        checkId: 'transport',
        evaluatedIssueIds: [],
        outcome: 'not-visited',
        reason: 'not_visited',
      }),
      findings: [],
    };
  }
  let response;
  try {
    response = await context.request.probeRootPort80();
  } catch (error) {
    if (!isScanTransportError(error)) {
      throw error;
    }
    // A refused port means that nothing listens on the cleartext port. That is
    // a successful negative only when the secure endpoint was reached in this
    // run; otherwise the issue stays unchecked.
    if (error.transportCause === 'refused' && secureEndpointReached(context)) {
      return {
        coverage: coverageRow({
          targetKey,
          checkId: 'transport',
          evaluatedIssueIds: ['http-served-without-redirect'],
          outcome: 'checked',
          reason: undefined,
        }),
        findings: [],
      };
    }
    return {
      coverage: coverageRow({
        targetKey,
        checkId: 'transport',
        evaluatedIssueIds: [],
        outcome: 'not-visited',
        reason: 'http_probe_unreachable',
      }),
      findings: [],
    };
  }
  const location = response.headers.get('location');
  const redirectedToHttps =
    location !== null && redirectsToHttps(location, probeUrl);
  const findings: OccurrenceFinding[] = [];
  if (!redirectedToHttps) {
    findings.push(
      buildFinding({
        context,
        targetKey,
        checkId: 'transport',
        issueId: 'http-served-without-redirect',
        subject: HTTP_ROOT_SUBJECT,
        safeLocation: safeLocationOf(context, probeUrl),
        validation: 'Confirmed',
        confidence: 'high',
        evidence: { status: response.status, redirected_to_https: false },
      }),
    );
  }
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'transport',
      evaluatedIssueIds: ['http-served-without-redirect'],
      outcome: 'checked',
      reason: undefined,
    }),
    findings,
  };
}
