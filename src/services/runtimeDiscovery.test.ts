import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    vi.restoreAllMocks();
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

    it('falls back to the CLI command when only the Gemini desktop GUI exists', () => {
      delete process.env.GEMINI_PATH;
      process.env.PATH = '';
      const guiPath = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Gemini', 'gemini.exe')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Gemini', 'bin', 'gemini');
      vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file) === guiPath);

      expect(findGemini()).toBe(process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    });

    it('still discovers the Gemini CLI when the desktop GUI is installed', () => {
      delete process.env.GEMINI_PATH;
      process.env.PATH = '';
      const cliPath = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd')
        : '/usr/local/bin/gemini';
      const guiPath = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Gemini', 'gemini.exe')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Gemini', 'bin', 'gemini');
      vi.spyOn(fs, 'existsSync').mockImplementation(file => [cliPath, guiPath].includes(String(file)));

      expect(findGemini()).toBe(cliPath);
    });
  });
});
