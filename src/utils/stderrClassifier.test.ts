import { describe, expect, it } from 'vitest';
import { createStderrClassifier } from './stderrClassifier.js';

const classify = (lines: string[]) => {
  const next = createStderrClassifier();
  return lines.map(line => next(line));
};

describe('agent stderr', () => {
  it('drops Codex start-up chatter and its WebSocket-to-HTTP fallback', () => {
    expect(classify([
      'Reading prompt from stdin...',
      '2026-10-23T06:25:28.434300Z WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell',
      '2026-10-23T06:25:30.000203Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required, url: ws://127.0.0.1:10100/v1/responses',
      '2026-10-23T06:25:30.003646Z WARN codex_core::client: falling back to HTTP'
    ]).every(line => line.drop)).toBe(true);
  });

  it('turns a failed agent command into one status line and drops the output it dumped', () => {
    const lines = classify([
      '2026-10-23T06:25:54.484057Z ERROR codex_core::tools::router: error=Exit code: 1',
      'Wall time: 1.1 seconds',
      'Output:',
      'NODE_ENV=development',
      'PORT=3000'
    ]);
    expect(lines[0]).toEqual({ drop: false, kind: 'tool_result', message: 'A command the agent ran did not succeed (Exit code: 1). The agent sees its output and carries on.' });
    expect(lines.slice(1).every(line => line.drop)).toBe(true);
  });

  it('keeps real errors as errors', () => {
    expect(classify(['Error: Cannot find module \'typescript\''])[0]).toEqual({ drop: false, kind: 'error', message: "[stderr] Error: Cannot find module 'typescript'" });
    expect(classify(['2026-10-23T06:25:54Z ERROR codex_core::exec: sandbox denied the write'])[0])
      .toEqual({ drop: false, kind: 'error', message: '[stderr] sandbox denied the write' });
  });
});

