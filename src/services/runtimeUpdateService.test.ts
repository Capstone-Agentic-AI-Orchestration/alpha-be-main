import { describe, expect, it } from 'vitest';
import { compareVersions, extractVersion, parseLatestLmStudioVersion } from './runtimeUpdateService.js';

describe('runtime update version helpers', () => {
  it('extracts versions from CLI output', () => {
    expect(extractVersion('codex-cli 0.154.0')).toBe('0.154.0');
    expect(extractVersion('OpenCode 1.18.5')).toBe('1.18.5');
    expect(extractVersion(undefined)).toBeUndefined();
  });

  it('compares numeric versions without treating the package name as part of it', () => {
    expect(compareVersions('0.155.1', '0.154.0')).toBeGreaterThan(0);
    expect(compareVersions('1.18.5', '1.18.31')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('extracts the LM Studio release from the official download page shape', () => {
    expect(parseLatestLmStudioVersion(
      '<a href="/download/latest/win32/x64">Download LM Studio for Windows 0.4.25</a>' +
      '<a href="/changelog/lmstudio-v0.4.25">Release notes</a>'
    )).toBe('0.4.25');
  });
});
