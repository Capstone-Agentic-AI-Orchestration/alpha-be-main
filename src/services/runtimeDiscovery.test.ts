import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findClaude,
  findCodex,
  findAntigravity,
  findGemini,
  findOpenCode
} from './runtimeDiscovery.js';

describe('runtimeDiscovery', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('explicit env var overrides', () => {
    it('prioritizes CLAUDE_PATH when set to an existing file', () => {
      const dummy = path.join(os.tmpdir(), 'dummy-claude');
      fs.writeFileSync(dummy, '#!/bin/sh\necho 1.0.0', { mode: 0o755 });
      process.env.CLAUDE_PATH = dummy;
      expect(findClaude()).toBe(dummy);
      fs.unlinkSync(dummy);
    });

    it('prioritizes CODEX_PATH when set to an existing file', () => {
      const dummy = path.join(os.tmpdir(), 'dummy-codex');
      fs.writeFileSync(dummy, '#!/bin/sh\necho 1.0.0', { mode: 0o755 });
      process.env.CODEX_PATH = dummy;
      expect(findCodex()).toBe(dummy);
      fs.unlinkSync(dummy);
    });

    it('prioritizes AGY_PATH when set to an existing file', () => {
      const dummy = path.join(os.tmpdir(), 'dummy-agy');
      fs.writeFileSync(dummy, '#!/bin/sh\necho 1.0.0', { mode: 0o755 });
      process.env.AGY_PATH = dummy;
      expect(findAntigravity()).toBe(dummy);
      fs.unlinkSync(dummy);
    });

    it('prioritizes GEMINI_PATH when set to an existing file', () => {
      const dummy = path.join(os.tmpdir(), 'dummy-gemini');
      fs.writeFileSync(dummy, '#!/bin/sh\necho 1.0.0', { mode: 0o755 });
      process.env.GEMINI_PATH = dummy;
      expect(findGemini()).toBe(dummy);
      fs.unlinkSync(dummy);
    });

    it('prioritizes OPENCODE_PATH when set to an existing file', () => {
      const dummy = path.join(os.tmpdir(), 'dummy-opencode');
      fs.writeFileSync(dummy, '#!/bin/sh\necho 1.0.0', { mode: 0o755 });
      process.env.OPENCODE_PATH = dummy;
      expect(findOpenCode()).toBe(dummy);
      fs.unlinkSync(dummy);
    });
  });

  describe('fallback resolution', () => {
    it('returns a non-empty binary string for all supported runtimes', () => {
      delete process.env.CLAUDE_PATH;
      delete process.env.CODEX_PATH;
      delete process.env.AGY_PATH;
      delete process.env.GEMINI_PATH;
      delete process.env.OPENCODE_PATH;

      expect(findClaude()).toBeTruthy();
      expect(findCodex()).toBeTruthy();
      expect(findAntigravity()).toBeTruthy();
      expect(findGemini()).toBeTruthy();
      expect(findOpenCode()).toBeTruthy();
    });

    it('does not resolve the Windows desktop GUI launcher for Gemini', () => {
      delete process.env.GEMINI_PATH;
      const resolved = findGemini();
      expect(resolved).not.toContain(path.join('Google', 'Gemini', 'gemini.exe'));
    });
  });
});
