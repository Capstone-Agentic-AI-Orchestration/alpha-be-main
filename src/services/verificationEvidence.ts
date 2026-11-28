/**
 * The lines of a failed verification that say what is wrong, for the repair attempt.
 *
 * The run log keeps the install output and every command's last 120 lines. Its tail is mostly
 * npm deprecation warnings and ts-jest notices, so a repair given "the last 30 lines" often saw
 * warnings while the real error -- error TS2345 at src/auth.ts(72,43), an ESLint rule at 33:72 --
 * had been cut off. This keeps the failing commands' error lines, in order, and drops the noise.
 */

const COMMAND_HEADER = /^\$ (.+) \((exit \d+|signal [\w-]+)\)$/;
const PREFIXED = /^\[([^\]]+)\] (.*)$/;
/** What an error looks like in TypeScript, ESLint, Jest/Vitest and npm output. */
const ERROR_PATTERNS: readonly RegExp[] = [
  /error TS\d+/i,                                   // tsc: src/auth.ts(72,43): error TS2345
  /^ *\d+:\d+ +(?:error|warning)\b/,                // eslint: 33:72  error  ...
  /✖ \d+ problem/,                                  // eslint summary
  /^\S+\.(?:ts|tsx|js|jsx|mjs|cjs)$/,                  // eslint file heading
  /^(?:FAIL|✕|×|●) /,                               // jest / vitest failures
  /\b(?:Expected|Received)\b|AssertionError/,
  /^(?:Error|TypeError|ReferenceError|SyntaxError)\b/,
  /Cannot find (?:module|name)/,
  /npm (?:ERR!|error)/,
  /Tests?: +\d+ failed|Test Suites?:.*failed/
];
const isErrorLine = (line: string) => ERROR_PATTERNS.some(pattern => pattern.test(line.trim()));
const NOISE = /npm warn|deprecated|ts-jest\[config\] \(WARN\)|ExperimentalWarning|^\s*$/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function failingCommandLines(logs: readonly string[]): Map<string, string[]> {
  const lines = new Map<string, string[]>();
  const failed = new Set<string>();
  for (const raw of logs) {
    const header = COMMAND_HEADER.exec(raw.trim());
    if (header) {
      if (header[2] !== 'exit 0') failed.add(header[1]);
      continue;
    }
    const prefixed = PREFIXED.exec(raw);
    if (!prefixed) continue;
    const list = lines.get(prefixed[1]) ?? [];
    list.push(prefixed[2].replace(ANSI, '').trimEnd());
    lines.set(prefixed[1], list);
  }
  return new Map([...failed].map(command => [command, lines.get(command) ?? []]));
}

/** Each failing command's error lines (or its last lines when none match), within maxChars. */
export function verificationFailureEvidence(logs: readonly string[], maxChars = 1_600): string {
  const sections: string[] = [];
  for (const [command, lines] of failingCommandLines(logs)) {
    const useful = lines.filter(line => !NOISE.test(line));
    const errors = useful.filter(isErrorLine);
    const shown = (errors.length ? errors : useful.slice(-12)).slice(0, 25).map(line => '  ' + line.trim().slice(0, 240));
    sections.push(command + ' failed' + (shown.length ? ':\n' + shown.join('\n') : ' with no output.'));
  }
  const evidence = sections.join('\n');
  return evidence.length > maxChars ? evidence.slice(0, maxChars - 1).trimEnd() + '…' : evidence;
}
