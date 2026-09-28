import { describe, expect, it } from 'vitest';

import type { DeploymentLogLine } from './deploymentLogs.js';
import { redactLogLines, redactText } from './redactLogs.js';

/** Secrets out of log lines: the service's own values exactly, and the usual credential shapes. */

const line = (message: string): DeploymentLogLine => ({
  id: '1',
  timestamp: '2026-01-01T00:00:00.000Z',
  message,
  level: 'info',
  type: 'app',
  instance: null,
  labels: {}
});

describe('redacting log lines', () => {
  it('replaces the service’s own variable values wherever they appear', () => {
    const [out] = redactLogLines([line('connecting to postgres://app:s3cretPass@db/shop with key abcdef123456')], [
      's3cretPass',
      'abcdef123456'
    ]);

    expect(out.message).not.toContain('s3cretPass');
    expect(out.message).not.toContain('abcdef123456');
  });

  it('leaves short values alone, so ordinary words survive', () => {
    const [out] = redactLogLines([line('listening on 3000, debug=true')], ['3000', 'true']);

    expect(out.message).toBe('listening on 3000, debug=true');
  });

  it.each([
    ['Authorization: Bearer eyJhbGciOi.payload.sig', 'Bearer [redacted]'],
    ['calling https://api/x?token=abc123&page=2', 'token=[redacted]&page=2'],
    ['{"password": "hunter22"}', '"password": "[redacted]"'],
    ['redis://default:pa55word@cache:6379', 'redis://[redacted]@cache:6379']
  ])('masks a credential shape: %s', (input, expected) => {
    expect(redactText(input, [])).toContain(expected);
  });

  it('keeps everything else about a line', () => {
    const [out] = redactLogLines([line('ok')], []);

    expect(out).toEqual(line('ok'));
  });
});
