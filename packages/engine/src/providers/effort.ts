/**
 * Thinking effort: one optional string in the config (`effort`), mapped per provider to that
 * provider's own reasoning parameter. An effort a provider or model does not know is ignored,
 * never an error, so a config written for one provider stays valid after switching models.
 *
 * Ported from the owner's Browser-controle extension (`provider-form.js` FALLBACK_EFFORTS and
 * the effort mapping in `openai-compatible.js`), converted to TypeScript.
 */

/**
 * How a provider takes a reasoning setting.
 * - `reasoning_effort`: OpenAI-style `reasoning_effort`, with `off` meaning "send nothing".
 * - `glm`: Z.ai GLM `thinking: { type: 'enabled' | 'disabled' }`.
 * - `gemini`: Gemini levels; thinking cannot be turned off on Gemini 3, so no `off`.
 * - `anthropic`: Claude extended / adaptive thinking.
 * - `deepseek`: DeepSeek V4 thinks by default (effort high); `thinking: {type: enabled|disabled}`
 *   switches it and `reasoning_effort` (low / high / max) grades it.
 * - `minimax`: MiniMax always thinks; `reasoning_split` moves the thinking out of the answer and
 *   `reasoning_effort` (low / medium / high / xhigh / max) grades it on the models that read it.
 * - `none`: the API rejects reasoning parameters, so nothing is ever sent.
 */
export type ThinkingStyle =
  | 'reasoning_effort'
  | 'glm'
  | 'deepseek'
  | 'gemini'
  | 'anthropic'
  | 'minimax'
  | 'none';

/** Efforts offered when a model list does not say which efforts a model takes. */
export const FALLBACK_EFFORTS: Readonly<Record<ThinkingStyle, readonly string[]>> = Object.freeze({
  reasoning_effort: ['off', 'low', 'medium', 'high'],
  glm: ['on', 'off'],
  deepseek: ['off', 'low', 'high', 'max'],
  gemini: ['minimal', 'low', 'medium', 'high'],
  anthropic: ['off', 'low', 'medium', 'high'],
  minimax: ['low', 'medium', 'high', 'xhigh', 'max'],
  none: [],
});

/** Values OpenAI-style `reasoning_effort` accepts (OpenAI, xAI, OpenRouter, Gemini's OpenAI endpoint). */
const REASONING_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Extra output tokens reserved for thinking, by effort. Thinking tokens count against the
 * output limit on every provider, so a review answer must not be cut short by its own
 * reasoning. Anthropic's `budget_tokens` uses the same table (it must stay below max_tokens).
 */
export const THINKING_BUDGET_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
});

/** Default output tokens added for models that think by default when no effort is configured. */
export const DEFAULT_THINKING_HEADROOM = 8192;

function normalize(effort: string | undefined): string {
  return (effort ?? '').trim().toLowerCase();
}

/** Output tokens to add on top of the answer budget for this effort; 0 when no thinking is asked. */
export function thinkingHeadroom(effort: string | undefined): number {
  return THINKING_BUDGET_TOKENS[normalize(effort)] ?? 0;
}

/** Values the native OpenAI API documents for `reasoning_effort` on reasoning models. */
const OPENAI_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

/**
 * OpenAI reasoning models (o-series and GPT-5 family, except the `-chat` variants). Other models
 * (gpt-4o, gpt-4.1, chatgpt-*) reject `reasoning_effort`, so nothing is sent for them.
 */
export const OPENAI_REASONING_MODEL = /^(?:o\d|gpt-5)(?![\w.-]*-chat)/;

export function openAIThinksByDefault(model: string): boolean {
  return OPENAI_REASONING_MODEL.test(model);
}

/**
 * OpenAI native: the `reasoning_effort` value to send, or undefined to send nothing: for a
 * non-reasoning model, for `off`, and for any value the OpenAI API does not accept.
 */
export function openAIReasoningEffort(model: string, effort: string | undefined): string | undefined {
  const value = normalize(effort);
  return OPENAI_REASONING_MODEL.test(model) && OPENAI_EFFORTS.has(value) ? value : undefined;
}

/**
 * The `reasoning_effort` values MiniMax accepts. `none` is rejected and the thinking cannot be
 * turned off, so an "off" effort asks for the shallowest depth instead.
 */
const MINIMAX_EFFORTS: Readonly<Record<string, string>> = Object.freeze({
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  off: 'low',
  none: 'low',
});

/** The only MiniMax model that honours `reasoning_effort`; the others ignore it. */
const MINIMAX_EFFORT_MODEL = /minimax-m3\.1-flash/i;

/**
 * Whether this MiniMax model takes `reasoning_effort`. The other MiniMax models ignore it and
 * think at their own default depth, so nothing is sent to them.
 */
export function minimaxTakesEffort(model: string | undefined): boolean {
  return model !== undefined && MINIMAX_EFFORT_MODEL.test(model);
}

/** OpenAI-compatible presets: the extra request-body fields for this effort and thinking style. */
export function compatibleEffortFields(
  style: ThinkingStyle,
  effort: string | undefined,
  model?: string,
): Record<string, unknown> {
  const value = normalize(effort);
  if (style === 'minimax') {
    // MiniMax keeps the thinking inside the answer unless the request asks for it out, and
    // `MiniMax-M3.1-Flash` rejects a request that asks it to stay in, so the split is always
    // asked for. The depth it takes is one of the values it documents; `none` is not one, and
    // only `MiniMax-M3.1-Flash` reads `reasoning_effort` at all.
    const graded = minimaxTakesEffort(model) ? MINIMAX_EFFORTS[value] : undefined;
    return { reasoning_split: true, ...(graded ? { reasoning_effort: graded } : {}) };
  }
  if (!value || style === 'none') return {};
  if (style === 'glm') {
    if (value === 'off') return { thinking: { type: 'disabled' } };
    if (value === 'on') return { thinking: { type: 'enabled' } };
    return {};
  }
  if (style === 'deepseek') {
    if (value === 'off' || value === 'none') return { thinking: { type: 'disabled' } };
    const graded = deepseekEffort(value);
    return graded ? { thinking: { type: 'enabled' }, reasoning_effort: graded } : {};
  }
  return REASONING_EFFORT_VALUES.has(value) ? { reasoning_effort: value } : {};
}

/**
 * The effort a style really sends, so the headroom follows what is sent: DeepSeek maps its
 * names onto the ones it documents, and MiniMax asks for the shallowest depth it accepts
 * when the effort asks for no thinking. A MiniMax model that ignores `reasoning_effort`
 * thinks at its own default depth (`max`), so the headroom follows that.
 */
export function sentEffort(style: ThinkingStyle, effort: string | undefined, model?: string): string | undefined {
  if (style === 'deepseek') return deepseekEffort(effort);
  if (style === 'minimax') {
    if (!minimaxTakesEffort(model)) return 'max';
    return MINIMAX_EFFORTS[normalize(effort)] ?? effort;
  }
  return effort;
}

/**
 * Whether an effort really stops the model from thinking. MiniMax cannot: it rejects
 * `reasoning_effort: none` and `thinking: { type: 'disabled' }`, so an effort that asks for
 * no thinking asks for the shallowest depth it accepts instead. The effort is read the same
 * way the request body reads it, so ` OFF ` asks for no thinking as well.
 */
export function effortStopsThinking(style: ThinkingStyle, effort: string | undefined): boolean {
  if (style === 'minimax') return false;
  const value = normalize(effort);
  return value === 'off' || value === 'none';
}

/** DeepSeek grades thinking as low / high / max; other names map to the nearest one it documents. */
const DEEPSEEK_EFFORTS: Readonly<Record<string, string>> = Object.freeze({
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
});

/** The effort DeepSeek really runs at for this configured value (undefined when it sends none). */
export function deepseekEffort(effort: string | undefined): string | undefined {
  return DEEPSEEK_EFFORTS[normalize(effort)];
}

/**
 * Output tokens reserved when a model thinks by default and no effort is configured. DeepSeek V4
 * defaults to effort `high`, whose reasoning outgrows the generic headroom on large diffs, and
 * MiniMax thinks at its default depth `max`, which needs the whole `max` budget.
 */
export function defaultThinkingHeadroom(style: ThinkingStyle | undefined): number {
  if (style === 'deepseek') return THINKING_BUDGET_TOKENS.high ?? DEFAULT_THINKING_HEADROOM;
  if (style === 'minimax') return THINKING_BUDGET_TOKENS.max ?? DEFAULT_THINKING_HEADROOM;
  return DEFAULT_THINKING_HEADROOM;
}

export type AnthropicThinking =
  | { thinking: { type: 'enabled'; budget_tokens: number } }
  | { thinking: { type: 'adaptive' }; output_config: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } };

/**
 * Claude models that take adaptive thinking with the `effort` parameter (Claude 4.6 and
 * later). Older models take `thinking.type = 'enabled'` with a token budget instead.
 */
const ADAPTIVE_CLAUDE = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|4-[6-9])(?:\b|-)/;
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Anthropic: thinking parameters for this model and effort, or undefined for no thinking. */
export function anthropicThinking(model: string, effort: string | undefined): AnthropicThinking | undefined {
  const value = normalize(effort);
  if (!ANTHROPIC_EFFORTS.has(value)) return undefined;
  if (ADAPTIVE_CLAUDE.test(model)) {
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort: value as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
    };
  }
  return { thinking: { type: 'enabled', budget_tokens: thinkingHeadroom(value) } };
}

/**
 * Output tokens reserved for adaptive Claude thinking, by Anthropic effort. Adaptive thinking
 * takes no budget: Claude decides how long to think and its thinking shares `max_tokens` with
 * the answer, so at high effort a large review batch outgrows the budget table above and the
 * JSON answer is cut (ADR-0011 amendment, 2026-10-16). Every Claude 5.x model allows 128k output.
 */
const ADAPTIVE_THINKING_HEADROOM: Readonly<Record<string, number>> = Object.freeze({
  low: 4096,
  medium: 16384,
  high: 32768,
  xhigh: 32768,
  max: 32768,
});

/** Headroom for adaptive Claude thinking at this effort; an absent or unknown effort runs at `high`. */
export function adaptiveThinkingHeadroom(effort: string | undefined): number {
  const value = normalize(effort);
  return ADAPTIVE_THINKING_HEADROOM[value === 'minimal' ? 'low' : value] ?? ADAPTIVE_THINKING_HEADROOM.high ?? 0;
}

/**
 * Claude 5 and later think adaptively when a request sends no `thinking` (Opus 5.5, Sonnet 5.5 and
 * Fable 5 cannot turn it off); Claude 4.6 to 4.8 run without thinking then.
 */
const THINKS_BY_DEFAULT_CLAUDE = /^claude-(?:opus|sonnet|haiku|fable|mythos)-[5-9](?:\b|-)/;

/**
 * Anthropic API: output tokens added on top of the answer for this model's thinking. A request
 * without `thinking` reserves the `high` headroom on a model that thinks anyway, since the default
 * effort is `high` on most of them (`medium` on Opus 5.5 and Haiku 5.5); otherwise 0.
 */
export function anthropicThinkingHeadroom(model: string, effort: string | undefined): number {
  const thinking = anthropicThinking(model, effort);
  if (!thinking) return THINKS_BY_DEFAULT_CLAUDE.test(model) ? adaptiveThinkingHeadroom(undefined) : 0;
  return thinking.thinking.type === 'adaptive' ? adaptiveThinkingHeadroom(effort) : thinkingHeadroom(effort);
}

export type GeminiThinkingConfig = { thinkingBudget: number } | { thinkingLevel: string };

const GEMINI_BUDGET_MODEL = /^gemini-(?:1|2)\./;
const GEMINI_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

/**
 * Gemini: `thinkingConfig` for this model and effort. Gemini 2.x takes a token budget
 * (`off` = 0, except Pro which cannot turn thinking off); Gemini 3 and later take a level
 * and cannot turn thinking off, so `off` is ignored there.
 */
export function geminiThinkingConfig(model: string, effort: string | undefined): GeminiThinkingConfig | undefined {
  const value = normalize(effort);
  const id = model.replace(/^models\//, '');
  if (GEMINI_BUDGET_MODEL.test(id)) {
    if (value === 'off') return /-pro/.test(id) ? undefined : { thinkingBudget: 0 };
    return GEMINI_LEVELS.has(value) ? { thinkingBudget: thinkingHeadroom(value) } : undefined;
  }
  return GEMINI_LEVELS.has(value) ? { thinkingLevel: value.toUpperCase() } : undefined;
}

/**
 * Models that have reasoning/thinking turned on by default in Gemini:
 * Gemini 2.5+, Gemini 3.x, and models with `-thinking` in their ID.
 */
export function geminiThinksByDefault(model: string): boolean {
  const id = model.replace(/^models\//, '').toLowerCase();
  return /^gemini-(?:[3-9]|\d{2,}|2\.[5-9])/.test(id) || id.includes('-thinking');
}

/**
 * Compatible presets / models that think by default without explicit effort parameter.
 */
const R1_TOKEN = /(?:^|[/:._-])r1(?:$|[/:._-])/;

export function isCompatibleReasoningModel(
  provider: string,
  model: string,
  style?: ThinkingStyle,
): boolean {
  const lowerModel = model.toLowerCase();
  // `r1` only as its own token (deepseek-r1, r1-distill), never inside another word.
  if (lowerModel.includes('reasoner') || R1_TOKEN.test(lowerModel)) {
    return true;
  }
  if (style === 'glm' || provider === 'zai' || provider === 'zai-coding') {
    return true;
  }
  // MiniMax always thinks and cannot be told not to; only the split of the thinking differs.
  if (style === 'minimax' || provider === 'minimax' || provider === 'minimax-coding-plan') {
    return true;
  }
  // DeepSeek V4 and later think by default on the official API.
  // Versioned ids (deepseek-v4-pro) and the current canonical ids (deepseek-flash, deepseek-pro).
  if ((style === 'deepseek' || provider === 'deepseek') && /deepseek-(?:v(?:[4-9]|\d{2})|flash|pro)\b/.test(lowerModel)) {
    return true;
  }
  // NVIDIA NIM reasoning models (Nemotron, R1 / QwQ distills, `-reasoning` / `thinking` ids).
  if (provider === 'nvidia' && (/nemotron|-reasoning|thinking|qwq/.test(lowerModel) || R1_TOKEN.test(lowerModel))) {
    return true;
  }
  // Vercel AI Gateway uses the same creator/model ids as OpenRouter.
  if (provider === 'openrouter' || provider === 'vercel-gateway') {
    if (
      lowerModel.includes(':thinking') ||
      /nemotron|qwq|deepseek-r1/.test(lowerModel) ||
      lowerModel.includes('reasoner') ||
      lowerModel.includes('r1') ||
      lowerModel.includes('thinking') ||
      /\b(?:o1|o3|o4|gpt-5)\b/.test(lowerModel) ||
      /gemini-(?:[3-9]|2\.[5-9])/.test(lowerModel)
    ) {
      return true;
    }
  }
  // Xiaomi MiMo: V2 pro/omni and every family from V2.5 on (V2.5 replaced V2 on 2026-06-30; V2.6, V3) think.
  if (/mimo-v2-(?:pro|omni)|mimo-v(?:2\.(?:[5-9]|\d{2})|[3-9]|\d{2})/.test(lowerModel)) {
    return true;
  }
  return false;
}
