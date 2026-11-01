/**
 * The scanner User-Agent (ADR-0052 section 2).
 *
 * Every outbound request identifies the scanner and carries a contact the
 * administrator controls, so a site's WAF logs can reach the owner who
 * authorized the scan.
 *
 * The contact is a header value, so it is validated before it is used. A value
 * with a control character could inject a second header, and a value that is
 * not a contact at all would put arbitrary administrator text into every
 * request the scanner makes. The rejected value never appears in the error
 * message: it is administrator-supplied text that must not reach a log.
 *
 * This module is the single owner of the format, so the package and the app
 * can never disagree about what the scanner calls itself.
 */

/** The scanner product token. */
export const SCANNER_USER_AGENT_TOKEN = 'MergePilot-WebScan/1';

/** Why a contact string was rejected. */
export type ScanContactErrorCode = 'empty' | 'control_character' | 'too_long' | 'not_a_contact';

/** A contact string the scanner refuses to put in a header. */
export class ScanContactError extends Error {
  readonly code: ScanContactErrorCode;

  constructor(code: ScanContactErrorCode, message: string) {
    super(message);
    this.name = 'ScanContactError';
    this.code = code;
  }
}

/** The longest accepted contact. */
const MAX_CONTACT_LENGTH = 200;

/** An email address, the contact shape most administrators use. */
const EMAIL_CONTACT = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** An http(s) URL, the other contact shape an administrator may use. */
const URL_CONTACT = /^https?:\/\/[^\s]+$/;

/**
 * Whether a value carries a control character.
 *
 * A control character in a header value could start a second header, so it
 * is checked by code point rather than by pattern.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Validates the administrator's contact string and returns its trimmed form.
 *
 * An empty contact is rejected: the scanner always identifies itself, so
 * there is no "anonymous" mode.
 */
export function validateScanContact(contact: string): string {
  const trimmed = contact.trim();
  if (trimmed === '') {
    throw new ScanContactError('empty', 'A scan contact is required.');
  }
  if (trimmed.length > MAX_CONTACT_LENGTH) {
    throw new ScanContactError(
      'too_long',
      `A scan contact must be at most ${MAX_CONTACT_LENGTH} characters.`,
    );
  }
  if (hasControlCharacter(trimmed)) {
    throw new ScanContactError(
      'control_character',
      'A scan contact must not contain control characters.',
    );
  }
  if (!EMAIL_CONTACT.test(trimmed) && !URL_CONTACT.test(trimmed)) {
    throw new ScanContactError(
      'not_a_contact',
      'A scan contact must be an email address or an http(s) URL.',
    );
  }
  return trimmed;
}

/**
 * The User-Agent every scanner request carries.
 *
 * The contact is validated here, so a header-injection attempt fails the
 * request instead of reaching the network.
 */
export function buildScannerUserAgent(contact: string): string {
  return `${SCANNER_USER_AGENT_TOKEN} (+${validateScanContact(contact)})`;
}
