import type { RunActivityKind } from '../models/index.js';

/** What to do with one line an agent CLI wrote to stderr. */
export type StderrLine = { drop: true } | { drop: false; kind: Extract<RunActivityKind, 'error' | 'status' | 'tool_result'>; message: string };

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s*(.*)$/;

/**
 * Sort an agent CLI's stderr into real errors and noise.
 *
 * Codex writes its own diagnostics to stderr with a timestamp and level, and when a
 * command the agent ran exits non-zero it dumps that command's whole output there too
 * (the agent already receives that output as its tool result). Logged as errors, a
 * routine `git status` or a missing node_modules filled every agent's activity with
 * red rows. Real failures still come through as errors; the rest becomes a short
 * status line or is dropped.
 */
export function createStderrClassifier(): (line: string) => StderrLine {
  let insideCommandOutput = false;
  return (raw: string): StderrLine => {
    const line = raw.trimEnd();
    if (!line.trim() || /^Reading prompt from stdin/i.test(line.trim())) return { drop: true };
    const match = LOG_LINE.exec(line);
    if (!match) {
      // The rest of a failed command's output, already shown as that command's result.
      if (insideCommandOutput) return { drop: true };
      return { drop: false, kind: 'error', message: `[stderr] ${line}` };
    }
    insideCommandOutput = false;
    const [, level, target, text] = match;
    if (level === 'TRACE' || level === 'DEBUG' || level === 'INFO') return { drop: true };
    if (target.endsWith('tools::router')) {
      insideCommandOutput = true;
      const reason = text.replace(/^error=/, '').trim();
      return { drop: false, kind: 'tool_result', message: `A command the agent ran did not succeed (${reason}). The agent sees its output and carries on.` };
    }
    // Codex tries a WebSocket first and falls back to HTTP when the local gateway does not speak it.
    if (target.includes('responses_websocket') && /426|Upgrade Required/i.test(text)) return { drop: true };
    if (/falling back to HTTP/i.test(text) || target.includes('shell_snapshot')) return { drop: true };
    if (level === 'WARN') return { drop: false, kind: 'status', message: `[warning] ${text}` };
    return { drop: false, kind: 'error', message: `[stderr] ${text}` };
  };
}

