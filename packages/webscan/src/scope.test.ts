import { describe, expect, it } from 'vitest';

import {
  ACTION_DENYLIST,
  evaluateCrawlTarget,
  evaluateExplicitTarget,
  evaluateExtraFilePath,
  evaluateTransportProbe,
  isActiveProbeAuthorized,
  isParameterizedLinkAuthorized,
  parseCanonicalUrl,
  type ScopeDecision,
} from './scope.js';
import type { ScanScope } from './types.js';

const SCOPE: ScanScope = {
  hostname: 'example.com',
  baseUrl: 'https://example.com/',
  crawlPaths: [{ path: '/docs', kind: 'prefix' }],
  blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
  parameterizedPaths: [],
  activePaths: [],
  extraFilePaths: [],
};

function expectDenied(reason: string, decision: ScopeDecision): void {
  expect(decision.allowed).toBe(false);
  expect(decision.reason).toBe(reason);
}

describe('the site host', () => {
  it('allows a link on the site itself', () => {
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com/docs/a')).toEqual({ allowed: true });
  });

  it('ignores the case and the trailing dot of the host', () => {
    expect(evaluateCrawlTarget(SCOPE, 'https://EXAMPLE.com/docs/a').allowed).toBe(true);
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com./docs/a').allowed).toBe(true);
  });

  it('denies a lookalike host that merely ends with the site host', () => {
    expectDenied('host_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com.evil.io/docs/a'));
  });

  it('denies an unlisted subdomain', () => {
    expectDenied('host_not_allowed', evaluateCrawlTarget(SCOPE, 'https://docs.example.com/docs/a'));
  });

  it('denies a redirect to another listed site', () => {
    const scope: ScanScope = { ...SCOPE, hostname: 'example.com' };

    expectDenied('host_not_allowed', evaluateCrawlTarget(scope, 'https://other.example.com/docs/a'));
  });
});

describe('ports and schemes', () => {
  it('allows the default https port', () => {
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com:443/docs/a').allowed).toBe(true);
  });

  it('denies an alternate port on the same host', () => {
    expectDenied('non_default_port', evaluateCrawlTarget(SCOPE, 'https://example.com:8443/docs/a'));
    expectDenied('non_default_port', evaluateCrawlTarget(SCOPE, 'https://example.com:80/docs/a'));
  });

  it('denies cleartext for a crawl target', () => {
    expectDenied('scheme_not_allowed', evaluateCrawlTarget(SCOPE, 'http://example.com/docs/a'));
  });

  it('denies a scheme that is not http', () => {
    expectDenied('unsupported_scheme', evaluateCrawlTarget(SCOPE, 'ftp://example.com/docs/a'));
    expectDenied('unsupported_scheme', evaluateCrawlTarget(SCOPE, 'javascript:alert(1)'));
  });
});

describe('credentials', () => {
  it('denies a URL that carries credentials', () => {
    expectDenied('credentials_present', evaluateCrawlTarget(SCOPE, 'https://user:pass@example.com/docs/a'));
    expectDenied('credentials_present', evaluateCrawlTarget(SCOPE, 'https://user@example.com/docs/a'));
  });
});

describe('path rules', () => {
  it('authorizes a prefix rule at a segment boundary', () => {
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com/docs').allowed).toBe(true);
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com/docs/a').allowed).toBe(true);
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com/docs/a/b').allowed).toBe(true);
  });

  it('never authorizes a sibling path that shares the prefix text', () => {
    expectDenied('path_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com/docs-admin'));
    expectDenied('path_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com/docsadmin/a'));
  });

  it('authorizes an exact rule only for that exact path', () => {
    const scope: ScanScope = { ...SCOPE, crawlPaths: [{ path: '/docs', kind: 'exact' }] };

    expect(evaluateCrawlTarget(scope, 'https://example.com/docs').allowed).toBe(true);
    expectDenied('path_not_allowed', evaluateCrawlTarget(scope, 'https://example.com/docs/a'));
  });

  it('authorizes nothing when the crawl list is empty', () => {
    const scope: ScanScope = { ...SCOPE, crawlPaths: [] };

    expectDenied('path_not_allowed', evaluateCrawlTarget(scope, 'https://example.com/docs/a'));
  });

  it('lets a blocked path win over an allow rule', () => {
    const scope: ScanScope = {
      ...SCOPE,
      crawlPaths: [{ path: '/', kind: 'prefix' }],
      blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
    };

    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/checkout'));
    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/checkout/card/1'));
    expect(evaluateCrawlTarget(scope, 'https://example.com/other').allowed).toBe(true);
  });
});

describe('the action denylist', () => {
  it('lists every denied action of the ADR', () => {
    expect([...ACTION_DENYLIST].sort()).toEqual(
      ['action', 'delete', 'logout', 'remove', 'reset', 'signout', 'unsubscribe'].sort(),
    );
  });

  it('denies a denied action in a path segment', () => {
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/logout'));
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/delete-user'));
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/unsubscribe'));
  });

  it('denies a denied action that is percent-encoded', () => {
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/%6cogout'));
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/%2Fsignout'));
  });

  it('denies a denied action in a query parameter name', () => {
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs?action=1'));
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs?%61ction=1'));
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs?reset=1'));
  });

  it('does not deny a path that merely looks similar', () => {
    expect(evaluateCrawlTarget(SCOPE, 'https://example.com/docs/catalog').allowed).toBe(true);
  });
});

describe('malformed input', () => {
  it('denies a malformed percent escape in the path', () => {
    expectDenied('malformed_encoding', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/%zz'));
  });

  it('denies a malformed percent escape in the query', () => {
    expectDenied('malformed_encoding', evaluateCrawlTarget(SCOPE, 'https://example.com/docs?a=%E0%A4%A'));
  });

  it('denies a URL that cannot be parsed', () => {
    expectDenied('invalid_url', evaluateCrawlTarget(SCOPE, 'not a url'));
  });
});

describe('parameterized links', () => {
  const scope: ScanScope = {
    ...SCOPE,
    parameterizedPaths: [{ path: '/docs', parameters: ['id'] }],
  };

  it('denies a query link without a separate authorization', () => {
    expectDenied('parameter_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com/docs?id=1'));
  });

  it('allows a query link whose exact path and parameter names are authorized', () => {
    expect(evaluateCrawlTarget(scope, 'https://example.com/docs?id=1').allowed).toBe(true);
  });

  it('allows a different value of an authorized parameter', () => {
    expect(evaluateCrawlTarget(scope, 'https://example.com/docs?id=99').allowed).toBe(true);
  });

  it('denies a query link that carries a parameter nobody authorized', () => {
    expectDenied('parameter_not_allowed', evaluateCrawlTarget(scope, 'https://example.com/docs?id=1&token=2'));
  });

  it('denies a query link whose path is only a prefix match of the authorization', () => {
    expectDenied('parameter_not_allowed', evaluateCrawlTarget(scope, 'https://example.com/docs/a?id=1'));
  });

  it('exposes the authorization as a separate decision', () => {
    const url = parseCanonicalUrl('https://example.com/docs?id=1');

    expect(isParameterizedLinkAuthorized(scope, url)).toBe(true);
    expect(isParameterizedLinkAuthorized(SCOPE, url)).toBe(false);
  });
});

describe('active probes', () => {
  it('are denied without an additional opt-in', () => {
    const url = parseCanonicalUrl('https://example.com/docs?id=1');

    expect(isActiveProbeAuthorized(SCOPE, url)).toBe(false);
  });

  it('are allowed for an authorized path and parameter name', () => {
    const scope: ScanScope = { ...SCOPE, activePaths: [{ path: '/docs', parameters: ['id'] }] };
    const url = parseCanonicalUrl('https://example.com/docs?id=1');

    expect(isActiveProbeAuthorized(scope, url)).toBe(true);
  });

  it('still need the parameterized crawl authorization of the link', () => {
    const scope: ScanScope = { ...SCOPE, activePaths: [{ path: '/docs', parameters: ['id'] }] };

    expectDenied('parameter_not_allowed', evaluateCrawlTarget(scope, 'https://example.com/docs?id=1'));
  });
});

describe('explicit targets', () => {
  it('allows the base page without a crawl rule', () => {
    const scope: ScanScope = { ...SCOPE, crawlPaths: [] };

    expect(evaluateExplicitTarget(scope, 'https://example.com/').allowed).toBe(true);
  });

  it('denies a base page that carries a query', () => {
    expectDenied('query_not_allowed', evaluateExplicitTarget(SCOPE, 'https://example.com/?a=1'));
  });

  it('denies a blocked explicit target', () => {
    expectDenied('blocked_path', evaluateExplicitTarget(SCOPE, 'https://example.com/checkout'));
  });
});

describe('the port-80 transport probe', () => {
  it('allows the fixed path over cleartext', () => {
    expect(evaluateTransportProbe(SCOPE, 'http://example.com/').allowed).toBe(true);
  });

  it('denies any other path over cleartext', () => {
    expectDenied('path_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com/docs'));
    expectDenied('path_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com/base/secret'));
  });

  it('denies a query over cleartext', () => {
    expectDenied('query_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com/?a=1'));
  });

  it('denies another host over cleartext', () => {
    expectDenied('host_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com.evil.io/'));
  });

  it('denies the fixed path when it is blocked', () => {
    const scope: ScanScope = { ...SCOPE, blockedPaths: [{ path: '/', kind: 'exact' }] };

    expectDenied('blocked_path', evaluateTransportProbe(scope, 'http://example.com/'));
  });

  it('denies a path that only resolves to the root after the server decodes it', () => {
    expectDenied('path_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com/%2f'));
    expectDenied('path_not_allowed', evaluateTransportProbe(SCOPE, 'http://example.com//'));
  });

  it('allows the root when the client itself normalizes the path to the root', () => {
    expect(evaluateTransportProbe(SCOPE, 'http://example.com/%2e%2e').allowed).toBe(true);
  });
});

describe('extra exposed-file paths', () => {
  it('allows a relative same-host path', () => {
    expect(evaluateExtraFilePath(SCOPE, '/backup.sql').allowed).toBe(true);
  });

  it('denies a path that is not relative', () => {
    expectDenied('not_relative_path', evaluateExtraFilePath(SCOPE, 'https://evil.io/backup.sql'));
  });

  it('denies a path that carries a query', () => {
    expectDenied('query_not_allowed', evaluateExtraFilePath(SCOPE, '/backup.sql?a=1'));
  });

  it('denies a blocked extra path', () => {
    expectDenied('blocked_path', evaluateExtraFilePath(SCOPE, '/checkout'));
  });

  it('denies an extra path that carries a denied action', () => {
    expectDenied('action_denied', evaluateExtraFilePath(SCOPE, '/logout'));
  });

  it('denies a protocol-relative path that would supply another origin', () => {
    expectDenied('host_not_allowed', evaluateExtraFilePath(SCOPE, '//evil.io/backup.sql'));
  });

  it('denies a backslash path that would supply another origin', () => {
    expectDenied('not_relative_path', evaluateExtraFilePath(SCOPE, '/\\evil.io/backup.sql'));
  });

  it('denies a traversal segment instead of resolving it elsewhere', () => {
    expectDenied('path_not_allowed', evaluateExtraFilePath(SCOPE, '/backup/../admin/config.sql'));
  });

  it('denies an encoded traversal segment', () => {
    expectDenied('path_not_allowed', evaluateExtraFilePath(SCOPE, '/backup/%2e%2e/admin.sql'));
  });

  it.each([
    '/backup/%2e%2e%2fadmin',
    '/backup/..%2Fadmin',
    '/backup%2f..%2fadmin',
  ])('denies traversal hidden behind an encoded separator: %s', (path) => {
    expectDenied('path_not_allowed', evaluateExtraFilePath(SCOPE, path));
  });
});

describe('adversarial hosts and paths', () => {
  it('denies a backslash authority that resolves to another origin', () => {
    expectDenied('host_not_allowed', evaluateCrawlTarget(SCOPE, 'https:\\evil.io/docs/a'));
  });

  it('denies a backslash authority that resolves to the site host', () => {
    expectDenied('host_not_allowed', evaluateCrawlTarget(SCOPE, 'https:\\example.com.evil.io/docs/a'));
  });

  it('denies a denied action whatever the case of the segment is', () => {
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/LogOut'));
  });

  it('denies a traversal that resolves outside the allowed prefix', () => {
    expectDenied('path_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/../admin'));
  });

  it('denies a traversal that resolves into a blocked path', () => {
    const scope: ScanScope = {
      ...SCOPE,
      crawlPaths: [{ path: '/', kind: 'prefix' }],
      blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
    };

    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/docs/../checkout'));
  });

  it('denies an encoded traversal that resolves into a blocked path', () => {
    const scope: ScanScope = {
      ...SCOPE,
      crawlPaths: [{ path: '/', kind: 'prefix' }],
      blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
    };

    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/docs/%2e%2e/checkout'));
    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/docs/%2e%2e%2fcheckout'));
    expectDenied('blocked_path', evaluateCrawlTarget(scope, 'https://example.com/docs%2f..%2fcheckout'));
  });

  it('denies an encoded traversal that resolves outside the allowed prefix', () => {
    expectDenied('path_not_allowed', evaluateCrawlTarget(SCOPE, 'https://example.com/docs/%2e%2e/admin'));
  });

  it('denies an encoded separator that would smuggle a denied action', () => {
    expectDenied('action_denied', evaluateCrawlTarget(SCOPE, 'https://example.com/docs%2flogout'));
  });
});
