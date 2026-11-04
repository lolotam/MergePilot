import { describe, expect, it } from 'vitest';
import * as contract from './contract.js';

/**
 * The package export `@mergepilot/app/contract` points at `contract.ts`. The dashboard
 * imports the scanner schemas from it, so every scanner contract module has to be
 * reachable through that barrel.
 */
describe('the public contract barrel', () => {
  it('exposes the site schemas that live in their own module', () => {
    expect(contract.WebScanSiteDtoSchema).toBeDefined();
    expect(contract.WebScanCreateSiteSchema).toBeDefined();
    expect(contract.WebScanUpdateSiteSchema).toBeDefined();
  });

  it('keeps exposing the scanner schemas of the main scanner module', () => {
    expect(contract.WebScanSettingsPatchSchema).toBeDefined();
    expect(contract.WebScanScanDetailSchema).toBeDefined();
  });

  it('exposes the schemas of the private target that live in their own module', () => {
    expect(contract.WebScanRepositoryRequestSchema).toBeDefined();
    expect(contract.WebScanApprovedInstallationRequestSchema).toBeDefined();
    expect(contract.WebScanTargetRefusedBodySchema).toBeDefined();
  });
});
