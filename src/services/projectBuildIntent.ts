/** Clear implementation requests start the project's managed build workflow. */
export function isProjectBuildRequest(content: string): boolean {
  const original = content.trim();
  const forcedBuild = /^\/build\s*/i.test(original);
  const text = original.replace(/^\/build\s*/i, '');
  if (!text) return false;
  const asksForExample = /\b(?:example|snippet|sample)\b/i.test(text)
    && /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?|help\s+me\s+(?:to\s+)?|i\s+want\s+(?:you\s+to\s+|to\s+))?(?:show|give|provide|write|generate|explain|describe)\b/i.test(text);
  if (!forcedBuild && asksForExample) return false;
  return /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?|help\s+me\s+(?:to\s+)?|i\s+want\s+(?:you\s+to\s+|to\s+)|i(?:'d| would)\s+like\s+(?:you\s+to\s+|to\s+)|i\s+need\s+you\s+to\s+|we\s+need\s+to\s+|let's\s+)?(?:build|create|make|implement|develop|add|fix|change|update|refactor|write)\b/i.test(text);
}
