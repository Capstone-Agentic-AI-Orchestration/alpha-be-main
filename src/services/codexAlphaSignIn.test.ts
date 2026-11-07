import { describe, expect, it } from 'vitest';
import { parseDeviceAuth } from './codexAlphaSignIn.js';

// Captured from codex-cli 0.166.0 `codex login --device-auth` (code changed).
const OUTPUT = '\nWelcome to Codex [v\u001b[90m0.166.0\u001b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n' +
  '1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n' +
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-E1234\u001b[0m\n';

describe('parseDeviceAuth', () => {
  it('reads the link and the one-time code without terminal colours', () => {
    expect(parseDeviceAuth(OUTPUT)).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-E1234' });
  });

  it('accepts only OpenAI links', () => {
    expect(parseDeviceAuth('Open https://evil.example.com/codex/device and enter ABCD-E1234').verificationUrl).toBeUndefined();
  });

  it('waits for both parts', () => {
    expect(parseDeviceAuth('1. Open this link https://auth.openai.com/codex/device')).toEqual({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: undefined });
  });
});
