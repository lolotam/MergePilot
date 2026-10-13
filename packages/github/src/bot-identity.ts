/**
 * The reviewer-panel bot shown inside a review (ADR-0017): one GitHub App, with the bot's name and
 * logo in the comment. The logo is a preset SVG served by the MergePilot app at
 * `{baseUrl}/bots/{logo}.svg`.
 */
export interface BotIdentity {
  name: string;
  /** A preset logo key (`pilot`, `owl`, …). */
  logo: string;
  /** `provider:model` of the bot's configured model. */
  modelLabel: string;
  /** The app's public URL (`MERGEPILOT_BASE_URL`); without it the logo is left out. */
  baseUrl?: string | undefined;
}

const LOGO_KEY = /^[a-z][a-z0-9-]{0,23}$/;
const DEFAULT_LOGO = 'pilot';

/**
 * Escapes text from settings or the model for one Markdown line: no HTML, no emphasis or links,
 * no table cell break, no hidden comment and no @-mention that would notify someone.
 */
export function escapeInline(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~|#])/g, '\\$1')
    .replace(/(^|[^\w])@(?=[A-Za-z0-9-])/g, '$1@​')
    .trim();
}

/** The logo `<img>` for a bot, or an empty string when there is no usable base URL. */
export function renderBotLogo(baseUrl: string | undefined, logo: string): string {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(base)) return '';
  const key = LOGO_KEY.test(logo) ? logo : DEFAULT_LOGO;
  return `<img src="${base}/bots/${key}.svg" width="20" height="20" alt="">`;
}

/** The identity line a bot's review starts with: logo, bold name and `· provider:model`. */
export function renderBotIdentity(identity: BotIdentity): string {
  const logo = renderBotLogo(identity.baseUrl, identity.logo);
  const name = `**${escapeInline(identity.name)}**`;
  const model = `\`${identity.modelLabel.replace(/`/g, '')}\``;
  return `${logo ? `${logo} ` : ''}${name} · ${model}`;
}
