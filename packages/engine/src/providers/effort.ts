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
 * - `none`: the API rejects reasoning parameters, so nothing is ever sent.
 */
export type ThinkingStyle = 'reasoning_effort' | 'glm' | 'gemini' | 'anthropic' | 'none';

/** Efforts offered when a model list does not say which efforts a model takes. */
export const FALLBACK_EFFORTS: Readonly<Record<ThinkingStyle, readonly string[]>> = Object.freeze({
  reasoning_effort: ['off', 'low', 'medium', 'high'],
  glm: ['on', 'off'],
  gemini: ['minimal', 'low', 'medium', 'high'],
  anthropic: ['off', 'low', 'medium', 'high'],
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

/** OpenAI-compatible presets: the extra request-body fields for this effort and thinking style. */
export function compatibleEffortFields(
  style: ThinkingStyle,
  effort: string | undefined,
): Record<string, unknown> {
  const value = normalize(effort);
  if (!value || style === 'none') return {};
  if (style === 'glm') {
    if (value === 'off') return { thinking: { type: 'disabled' } };
    if (value === 'on') return { thinking: { type: 'enabled' } };
    return {};
  }
  return REASONING_EFFORT_VALUES.has(value) ? { reasoning_effort: value } : {};
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
export function isCompatibleReasoningModel(
  provider: string,
  model: string,
  style?: ThinkingStyle,
): boolean {
  const lowerModel = model.toLowerCase();
  if (provider === 'deepseek' && (lowerModel.includes('reasoner') || lowerModel.includes('r1'))) {
    return true;
  }
  if (lowerModel.includes('reasoner') || lowerModel.includes('r1')) {
    return true;
  }
  if (style === 'glm' || provider === 'zai' || provider === 'zai-coding') {
    return true;
  }
  if (provider === 'openrouter') {
    if (
      lowerModel.includes('reasoner') ||
      lowerModel.includes('r1') ||
      lowerModel.includes('thinking') ||
      /\b(?:o1|o3|o4|gpt-5)\b/.test(lowerModel) ||
      /gemini-(?:[3-9]|2\.[5-9])/.test(lowerModel)
    ) {
      return true;
    }
  }
  return false;
}
