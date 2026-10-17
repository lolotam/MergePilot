/**
 * The system-prompt line that carries a call's `responseSchema` to a model that is not sent the
 * schema natively. The schema says which keys are required: without it, a model with nothing to
 * report may leave `findings` out instead of sending an empty list (ADR-0011).
 */
export function responseSchemaInstruction(schema: Record<string, unknown>): string {
  return `Respond with a single JSON object matching this JSON schema:\n${JSON.stringify(schema)}`;
}
