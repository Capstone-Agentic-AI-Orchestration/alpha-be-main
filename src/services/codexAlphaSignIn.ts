import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { RuntimeService } from './runtimeService.js';
import { childProcessEnv } from './childProcessEnv.js';
import { codexAlphaHome, codexAlphaSignedIn } from './cliHome.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Signing in to Codex for Alpha, so Codex agents run from Alpha's own home
 * instead of the operator's `~/.codex` (see cliHome).
 *
 * Uses `codex login --device-auth`: Codex prints a verification link and a
 * one-time code, and finishes on its own once the person enters the code in
 * their browser. Nothing is copied from the operator's own sign-in.
 */
export interface CodexAlphaSignInState {
  status: 'signed_out' | 'waiting' | 'signed_in' | 'failed' | 'expired';
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  error?: string;
}

const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1000;
const ANSI = /\u001b\[[0-9;]*m/g;

/** The verification link and code from `codex login --device-auth` output. Only OpenAI links are accepted. */
export function parseDeviceAuth(output: string): { verificationUrl?: string; userCode?: string } {
  const text = output.replace(ANSI, '');
  const url = text.match(/https:\/\/(?:[a-z0-9-]+\.)*openai\.com\/[^\s)]+/i)?.[0];
  const code = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1];
  return { verificationUrl: url, userCode: code };
}

class CodexAlphaSignIn {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: CodexAlphaSignInState = { status: 'signed_out' };

  current(): CodexAlphaSignInState {
    if (this.child) return this.state;
    if (codexAlphaSignedIn()) return { status: 'signed_in' };
    return this.state.status === 'signed_in' ? { status: 'signed_out' } : this.state;
  }

  /** Start a device sign-in, or return the one already waiting. */
  start(onSignedIn?: () => void): Promise<CodexAlphaSignInState> {
    if (this.child) return Promise.resolve(this.state);
    if (codexAlphaSignedIn()) return Promise.resolve({ status: 'signed_in' });

    return new Promise(resolve => {
      let output = '';
      let answered = false;
      const answer = () => {
        if (answered) return;
        answered = true;
        resolve(this.state);
      };
      let child: ChildProcess;
      try {
        child = crossSpawn(RuntimeService.codexPath(), ['login', '--device-auth'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childProcessEnv({ CODEX_HOME: codexAlphaHome() })
        });
      } catch (err) {
        this.state = { status: 'failed', error: 'Codex could not be started. Check that the Codex CLI is installed.' };
        logError('Codex sign-in for Alpha could not start: ' + String(err));
        answer();
        return;
      }
      this.child = child;
      this.state = { status: 'waiting', expiresAt: new Date(Date.now() + DEVICE_CODE_LIFETIME_MS).toISOString() };

      const read = (chunk: unknown) => {
        output += String(chunk);
        const parsed = parseDeviceAuth(output);
        if (parsed.verificationUrl && parsed.userCode && this.state.status === 'waiting' && !this.state.userCode) {
          this.state = { ...this.state, ...parsed };
          answer();
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', () => {
        this.finish({ status: 'failed', error: 'Codex sign-in stopped unexpectedly.' });
        answer();
      });
      child.on('close', code => {
        if (code === 0 && codexAlphaSignedIn()) {
          this.finish({ status: 'signed_in' });
          logInfo('Codex is signed in for Alpha; Codex agents now use Alpha\'s own home.');
          onSignedIn?.();
        } else if (this.state.status === 'waiting') {
          const last = output.replace(ANSI, '').trim().split(/\r?\n/).filter(Boolean).pop();
          this.finish({ status: 'failed', error: last ? last.slice(0, 240) : 'Codex sign-in did not finish.' });
        }
        answer();
      });
      this.timer = setTimeout(() => {
        this.child?.kill();
        this.finish({ status: 'expired', error: 'The sign-in code expired. Start again.' });
      }, DEVICE_CODE_LIFETIME_MS);
      // Codex prints the link within a second or two; do not hold the request open forever.
      setTimeout(answer, 20_000);
    });
  }

  cancel(): CodexAlphaSignInState {
    if (this.child) {
      this.child.kill();
      this.finish({ status: 'signed_out' });
    }
    return this.current();
  }

  /** Sign Codex out of Alpha's home. The operator's own Codex sign-in is untouched. */
  async signOut(): Promise<CodexAlphaSignInState> {
    this.cancel();
    await new Promise<void>(resolve => {
      try {
        const child = crossSpawn(RuntimeService.codexPath(), ['logout'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: childProcessEnv({ CODEX_HOME: codexAlphaHome() })
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      } catch {
        resolve();
      }
    });
    this.state = codexAlphaSignedIn()
      ? { status: 'failed', error: 'Codex did not sign out. Try again.' }
      : { status: 'signed_out' };
    return this.state;
  }

  private finish(next: CodexAlphaSignInState) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child = null;
    this.state = next;
  }
}

export const codexAlphaSignIn = new CodexAlphaSignIn();
