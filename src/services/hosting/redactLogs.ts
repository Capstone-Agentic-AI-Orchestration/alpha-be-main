import type { DeploymentLogLine } from './deploymentLogs.js';

/**
 * Secrets out of log lines before they leave the server.
 *
 * Hosting logs reach people who may not see a service's variables, and
 * agents -- whose tool output is stored in run logs that sync to the cloud.
 * An app that prints its own configuration at boot would otherwise publish
 * it. Two layers: the service's own variable values, which are known exactly,
 * and the shapes credentials usually take in a line.
 */

const REDACTED = '[redacted]';

/** Shorter values would redact ordinary words (`true`, `3000`, `info`). */
const MIN_SECRET_LENGTH = 6;

const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\b(authorization|token|secret|password|passwd|api[_-]?key|access[_-]?key)(["']?\s*[:=]\s*["']?)(?!Bearer\b|\[redacted\])[^\s"'&,;]+/gi, `$1$2${REDACTED}`],
  // Credentials inside a URL: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`]
];

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const [pattern, replacement] of CREDENTIAL_SHAPES) out = out.replace(pattern, replacement);
  return out;
}

export function redactLogLines(lines: readonly DeploymentLogLine[], secretValues: readonly (string | null | undefined)[]): DeploymentLogLine[] {
  // Longest first, so a secret that contains another is replaced whole.
  const secrets = [...new Set(secretValues.filter((v): v is string => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length
  );
  return lines.map(line => ({ ...line, message: redactText(line.message, secrets) }));
}
