/**
 * Model and author text is untrusted: it must not forge our idempotency marker, close the
 * RTL wrapper, or @-mention (and so notify) real people or teams.
 */
export function neutralize(text: string): string {
  return text
    .replaceAll('<!--', '&lt;!--')
    .replace(/<\/div/gi, '&lt;/div')
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9-])/g, '$1@​');
}
