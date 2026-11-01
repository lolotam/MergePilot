/**
 * The bounded crawler (ADR-0052 section 2).
 *
 * The crawler discovers links and requests the authorized ones. It never
 * executes a script, never submits a form and never leaves the host of the
 * scan. The HTML is read with a real parser, so a malformed document, a
 * repeated link or an unusual attribute never changes what is discovered.
 *
 * Two rules keep the crawl inside the authorization:
 *
 * - A link is requested only when the scope allows it: the same host, the
 *   administrator's crawl path rules, no blocked path, no denied action and,
 *   for a parameterized link, an explicit authorization of every parameter
 *   name it carries.
 * - The links are canonicalized before they are queued (WHATWG URL parsing,
 *   fragment removal, default-port normalization), so the same link is
 *   requested once and never with its fragment.
 */

import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import { createCandidateLedger, type ScanCandidate } from './candidates.js';
import type { ScanClient, ScanClientRequest, ScanTargetKind } from './client.js';
import {
  ScanPolicyError,
  ScanStopError,
  ScanTransportError,
  type ScanTransportCause,
} from './errors.js';
import {
  canonicalHostname,
  evaluateCrawlTarget,
  isParameterizedLinkAuthorized,
  parseCanonicalUrl,
  type CanonicalUrl,
} from './scope.js';
import type { ScanLimits, ScanScope, ScanStopReason } from './types.js';

/** One page the crawler received. */
export interface CrawledPage {
  /** The URL the page was requested from. Transient: it never leaves this process. */
  readonly url: string;
  /** The identity of the baseline target. */
  readonly targetKey: string;
  /** How the page was requested. */
  readonly kind: ScanTargetKind;
  readonly status: number;
  readonly headers: Headers;
  /** The bounded body of the page. */
  readonly body: Uint8Array;
  /** Whether the body of the requested destination was reached. */
  readonly destinationReached: boolean;
  /** How many redirect hops were followed. */
  readonly hops: number;
  /** The URL the chain ended at. Transient: it never leaves this process. */
  readonly finalUrl: string;
  /**
   * The `Location` of a redirect the crawler did not follow.
   *
   * It is transient like every other URL: a check needs it to tell a redirect
   * away from a missing file, and it never reaches a result.
   */
  readonly location: string | null;
}

/** A target that could not be read. */
export interface CrawlTargetError {
  readonly targetKey: string;
  readonly kind: ScanTargetKind;
  readonly transportCause: ScanTransportCause;
}

/** What the crawler found. */
export interface CrawlResult {
  readonly pages: readonly CrawledPage[];
  readonly errors: readonly CrawlTargetError[];
  /** How many distinct links were discovered. */
  readonly discovered: number;
  /** Whether the page cap ended the crawl with links still pending. */
  readonly pageCapReached: boolean;
  /**
   * Whether the crawler had to drop links it had found.
   *
   * The plan of the crawler is bounded by the budgets of the scan, so a page
   * with more links than the scan may visit ends with links that were never
   * requested. The scan reports that as a partial coverage.
   */
  readonly linkCapReached: boolean;
  /**
   * Whether a parameterized candidate was dropped.
   *
   * The candidates are bounded by the active budget of the scan, so a page
   * with more authorized parameterized links than the administrator approved
   * ends with candidates that no check may look at.
   */
  readonly candidateCapReached: boolean;
  /** The authorized parameterized links the crawl found. */
  readonly candidates: readonly ScanCandidate[];
  /** Whether the base target of the site could not be read. */
  readonly baseTargetFailed: boolean;
  /** The stop condition that ended the crawl, when one did. */
  readonly stopped: ScanStopReason | undefined;
}

/** What the crawler needs to do its work. */
export interface CrawlOptions {
  readonly client: ScanClient;
  readonly scope: ScanScope;
  readonly limits: ScanLimits;
  /** The app-supplied identity of a baseline URL. */
  readonly identifyTarget: (baselineUrl: string) => string;
  /** Called after every page the crawler received. */
  readonly onPage?: (pages: number, requests: number) => void;
}

/** The attribute value of an element, or null. */
function attributeValue(element: DefaultTreeAdapterTypes.Element, name: string): string | null {
  for (const attribute of element.attrs) {
    if (attribute.name === name) {
      return attribute.value;
    }
  }
  return null;
}

/** Whether a node is an element. A tag name never starts with a hash. */
function isElementNode(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

/** Whether an element is a template, whose content sits in its own tree. */
function isTemplateNode(
  element: DefaultTreeAdapterTypes.Element,
): element is DefaultTreeAdapterTypes.Template {
  return element.nodeName === 'template';
}

/**
 * Walks the document and hands every element to the visitor.
 *
 * The visitor also learns whether the element sits inside the head, which is
 * where a `base` element is meaningful.
 */
function collectElements(
  node: DefaultTreeAdapterTypes.ParentNode,
  inHead: boolean,
  visit: (element: DefaultTreeAdapterTypes.Element, inHead: boolean) => void,
): void {
  for (const child of node.childNodes) {
    if (!isElementNode(child)) {
      continue;
    }
    const head = inHead || child.tagName === 'head';
    visit(child, head);
    if (isTemplateNode(child)) {
      collectElements(child.content, inHead, visit);
      continue;
    }
    collectElements(child, head, visit);
  }
}

/**
 * The document base of a page.
 *
 * A `base` element changes how a browser resolves a relative link, so the
 * crawler resolves them the same way. Only a base inside the head counts, and
 * a base that is not an http(s) URL is ignored.
 */
function documentBase(
  document: DefaultTreeAdapterTypes.Document,
  pageUrl: string,
): string {
  let raw: string | null = null;
  collectElements(document, false, (element, inHead) => {
    if (raw !== null || !inHead || element.tagName !== 'base') {
      return;
    }
    raw = attributeValue(element, 'href');
  });
  if (raw === null) {
    return pageUrl;
  }
  try {
    const resolved = new URL(raw, pageUrl);
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
      return pageUrl;
    }
    return resolved.href;
  } catch {
    return pageUrl;
  }
}

/**
 * The canonical form of a discovered link.
 *
 * The fragment is removed because it is never sent to the server, and the
 * default port is normalized so the same link is recognized twice.
 */
function canonicalLink(raw: string, base: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    return null;
  }
  return `${resolved.protocol}//${resolved.host}${resolved.pathname}${resolved.search}`;
}

/**
 * The links of a page.
 *
 * Only the `href` of an anchor and of an area is read. A form is never
 * submitted and a script is never executed, so their targets are not links.
 */
function pageLinks(html: string, pageUrl: string): string[] {
  const document = parse(html);
  const base = documentBase(document, pageUrl);
  const links: string[] = [];
  collectElements(document, false, (element) => {
    if (element.tagName !== 'a' && element.tagName !== 'area') {
      return;
    }
    const href = attributeValue(element, 'href');
    if (href === null) {
      return;
    }
    const link = canonicalLink(href.trim(), base);
    if (link !== null) {
      links.push(link);
    }
  });
  return links;
}

/** Decodes a body for parsing. A page that is not UTF-8 loses its odd bytes. */
function decodeBody(body: Uint8Array): string {
  return new TextDecoder('utf-8').decode(body);
}

/**
 * The plan of the crawler, bounded by the budgets of the scan.
 *
 * The plan holds the links the crawl may still request. It never holds more
 * links than the scan may request, and a link the scope refuses never enters
 * it: a page with a thousand denied links cannot grow the memory of the
 * worker nor push the links that are allowed out of the plan.
 */
interface CrawlPlan {
  /** The links the crawl queued or visited. */
  readonly planned: Set<string>;
  /** How many discovered links the plan holds. The base target is not one. */
  plannedLinks: number;
  /** The distinct links the crawl saw. Bounded: it never grows without limit. */
  readonly seen: Set<string>;
  /** Whether a link had to be dropped. */
  truncated: boolean;
}

/** Creates the bounded plan of a crawl. */
function createPlan(): CrawlPlan {
  return { planned: new Set<string>(), plannedLinks: 0, seen: new Set<string>(), truncated: false };
}

/**
 * The candidate a discovered link is, when it may be one.
 *
 * A candidate is a same-host HTTPS link whose exact path and whose parameter
 * names are authorized. Its query values are never part of the authorization,
 * so two links that differ only in a value are two different candidates.
 */
function candidateOf(
  scope: ScanScope,
  link: string,
  identifyTarget: (baselineUrl: string) => string,
): ScanCandidate | null {
  let url: CanonicalUrl;
  try {
    url = parseCanonicalUrl(link);
  } catch {
    return null;
  }
  if (url.hostname !== canonicalHostname(scope.hostname) || url.protocol !== 'https:') {
    return null;
  }
  if (!isParameterizedLinkAuthorized(scope, url)) {
    return null;
  }
  return {
    url: link,
    path: url.path,
    targetKey: identifyTarget(link),
    parameterNames: [...url.queryNames],
  };
}

/**
 * Crawls the site within its authorized scope.
 *
 * The base page is an explicit target: it is bound to its own path and does
 * not need a crawl rule. Every other target is a discovered link and must
 * satisfy the crawl rules.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const { client, scope, limits, identifyTarget } = options;
  const pages: CrawledPage[] = [];
  const errors: CrawlTargetError[] = [];
  const pending: ScanClientRequest[] = [];
  // The plan may never hold more links than the scan may request. The bound is
  // the request budget and not the page budget: a smaller plan would end the
  // crawl before the page cap and the request budget could report themselves.
  const linkCap = Math.max(1, limits.maxRequests);
  const plan = createPlan();
  const candidates = createCandidateLedger(limits.maxActiveLinks);
  let pageCapReached = false;
  let baseTargetFailed = false;
  let stopped: ScanStopReason | undefined;
  let attempted = 0;

  let baseUrl: string;
  let basePath: string;
  try {
    const parsed = parseCanonicalUrl(scope.baseUrl);
    baseUrl = `${parsed.protocol}//${parsed.host}${parsed.path}`;
    basePath = parsed.path;
  } catch {
    throw new ScanPolicyError('invalid_url', 'The scan base URL is outside the authorized transport policy.');
  }
  plan.planned.add(baseUrl);
  pending.push({ url: baseUrl, kind: 'explicit', authorizedPath: basePath });

  while (pending.length > 0) {
    if (pages.length >= limits.maxPages) {
      pageCapReached = true;
      break;
    }
    const request = pending.shift();
    if (request === undefined) {
      break;
    }
    // The base page is the first target of the scan, so a failure there is a
    // failure of the site itself rather than of one link.
    const isBaseTarget = attempted === 0;
    attempted += 1;
    const targetKey = identifyTarget(request.url);
    try {
      const response = await client.request(request);
      pages.push({
        url: request.url,
        targetKey,
        kind: request.kind,
        status: response.status,
        headers: response.headers,
        body: response.body,
        destinationReached: response.destinationReached,
        hops: response.hops,
        finalUrl: response.finalUrl,
        location: response.headers.get('location'),
      });
      options.onPage?.(pages.length, client.requestCount);
      if (!response.destinationReached) {
        continue;
      }
      for (const link of pageLinks(decodeBody(response.body), response.finalUrl)) {
        if (!plan.seen.has(link)) {
          // The ledger of what was seen is bounded: a page cannot make the
          // crawler remember more than the budgets allow.
          if (plan.seen.size < linkCap) {
            plan.seen.add(link);
          } else {
            plan.truncated = true;
          }
        }
        const candidate = candidateOf(scope, link, identifyTarget);
        if (candidate !== null) {
          candidates.keep(candidate);
        }
        if (plan.planned.has(link)) {
          continue;
        }
        if (!evaluateCrawlTarget(scope, link).allowed) {
          // A link the scope refuses never enters the plan: it is not
          // requested, and it does not take the room of a link that is.
          continue;
        }
        if (plan.plannedLinks >= linkCap) {
          plan.truncated = true;
          continue;
        }
        plan.planned.add(link);
        plan.plannedLinks += 1;
        pending.push({ url: link, kind: 'crawl' });
      }
    } catch (error) {
      if (error instanceof ScanStopError) {
        stopped = error.reason;
        break;
      }
      if (error instanceof ScanTransportError) {
        errors.push({ targetKey, kind: request.kind, transportCause: error.transportCause });
        if (isBaseTarget) {
          baseTargetFailed = true;
        }
        continue;
      }
      throw error;
    }
  }

  return {
    pages,
    errors,
    discovered: plan.seen.size,
    pageCapReached,
    linkCapReached: plan.truncated,
    candidateCapReached: candidates.truncated,
    candidates: candidates.candidates,
    baseTargetFailed,
    stopped,
  };
}
