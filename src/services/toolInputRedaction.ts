/**
 * Secrets out of an agent's tool calls before they are logged.
 *
 * A run's log stores every tool call's input, and the log syncs to the
 * cloud where the whole team can read the run. A tool that sets a secret --
 * a hosting variable's value -- would otherwise publish it there. Tools are
 * matched by their own name inside whatever prefix the CLI adds
 * (`mcp__alpha-hosting__hosting_env_set`, `alpha-hosting.hosting_env_set`).
 */

const REDACTED = '[redacted]';

/** Tool name suffix -> how to mask its input. */
const SENSITIVE_TOOLS: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
  hosting_env_set: input => ({
    ...input,
    vars: Array.isArray(input.vars)
      ? input.vars.map(v => (v && typeof v === 'object' ? { ...(v as Record<string, unknown>), value: REDACTED } : v))
      : input.vars
  })
};

export function redactToolInput(toolName: string | undefined, input: unknown): unknown {
  if (!toolName || !input || typeof input !== 'object') return input;
  const match = Object.keys(SENSITIVE_TOOLS).find(name => toolName === name || toolName.endsWith(`__${name}`) || toolName.endsWith(`.${name}`));
  return match ? SENSITIVE_TOOLS[match](input as Record<string, unknown>) : input;
}
