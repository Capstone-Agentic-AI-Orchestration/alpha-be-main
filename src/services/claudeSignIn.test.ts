import { describe, expect, it } from 'vitest';
import { parseClaudeSignInUrl } from './claudeSignIn.js';

// Captured from Claude Code `claude auth login --claudeai` with no browser (query shortened).
const OUTPUT = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ';

describe('parseClaudeSignInUrl', () => {
  it('reads the fallback sign-in link', () => {
    expect(parseClaudeSignInUrl(OUTPUT)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz');
  });

  it('accepts only Anthropic links', () => {
    expect(parseClaudeSignInUrl('visit: https://claude.com.evil.example/oauth')).toBeUndefined();
    expect(parseClaudeSignInUrl('visit: https://evil.example/claude.com/oauth')).toBeUndefined();
  });

  it('waits until the link is printed', () => {
    expect(parseClaudeSignInUrl('Opening browser to sign in…')).toBeUndefined();
  });
});
