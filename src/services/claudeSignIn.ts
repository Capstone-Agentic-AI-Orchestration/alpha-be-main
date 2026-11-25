import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { RuntimeService, runClosedStdin } from './runtimeService.js';
import { childProcessEnv } from './childProcessEnv.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Signing Claude Code in to a Claude subscription from inside Alpha.
 *
 * Runs `claude auth login --claudeai`, the same sign-in a person would run in
 * a terminal, so Claude Code keeps its credentials itself and Alpha never sees
 * them. Claude Code opens the browser and usually finishes on its own. When no
 * browser tab opens, it prints a sign-in link instead, and the page behind that
 * link shows a code to paste back, which `submitCode` passes to Claude Code.
 *
 * This is the person's own Claude Code sign-in (~/.claude). Claude Code's
 * credentials live there, so Alpha cannot give it a separate home the way it
 * does for Codex.
 */
export interface ClaudeSignInState {
  status: 'signed_out' | 'waiting' | 'signed_in' | 'failed' | 'expired';
  /** The link Claude Code printed for when its browser tab did not open. */
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
}

const SIGN_IN_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CODE_LENGTH = 1_000;
const ANSI = /\u001b\[[0-9;]*m/g;

/** The sign-in link from `claude auth login` output. Only Anthropic's own sites are accepted. */
export function parseClaudeSignInUrl(output: string): string | undefined {
  const text = output.replace(ANSI, '');
  return text.match(/https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)\/[^\s)]+/i)?.[0];
}

/** Whether Claude Code reports a signed-in account. */
async function claudeSignedIn(): Promise<boolean> {
  const probe = await runClosedStdin(RuntimeService.claudePath(), ['auth', 'status'], 15_000);
  try {
    return JSON.parse(probe.stdout).loggedIn === true;
  } catch {
    return false;
  }
}

class ClaudeSignIn {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: ClaudeSignInState = { status: 'signed_out' };

  async current(): Promise<ClaudeSignInState> {
    if (this.child) return this.state;
    if (await claudeSignedIn()) return { status: 'signed_in' };
    return this.state.status === 'signed_in' ? { status: 'signed_out' } : this.state;
  }

  /** Start a sign-in, or return the one already waiting. */
  async start(onSignedIn?: () => void): Promise<ClaudeSignInState> {
    if (this.child) return this.state;
    if (await claudeSignedIn()) return { status: 'signed_in' };

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
        child = crossSpawn(RuntimeService.claudePath(), ['auth', 'login', '--claudeai'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childProcessEnv()
        });
      } catch (err) {
        this.state = { status: 'failed', error: 'Claude Code could not be started. Check that it is installed.' };
        logError('Claude sign-in could not start: ' + String(err));
        answer();
        return;
      }
      this.child = child;
      this.state = { status: 'waiting', expiresAt: new Date(Date.now() + SIGN_IN_LIFETIME_MS).toISOString() };

      const read = (chunk: unknown) => {
        output += String(chunk);
        const verificationUrl = parseClaudeSignInUrl(output);
        if (verificationUrl && this.state.status === 'waiting' && !this.state.verificationUrl) {
          this.state = { ...this.state, verificationUrl };
          answer();
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', () => {
        this.finish({ status: 'failed', error: 'Claude sign-in stopped unexpectedly.' });
        answer();
      });
      child.on('close', () => {
        void claudeSignedIn().then(signedIn => {
          if (signedIn) {
            this.finish({ status: 'signed_in' });
            logInfo('Claude Code is signed in to a Claude account.');
            onSignedIn?.();
          } else if (this.state.status === 'waiting') {
            const last = output.replace(ANSI, '').trim().split(/\r?\n/).filter(Boolean).pop();
            this.finish({ status: 'failed', error: last ? last.slice(0, 240) : 'Claude sign-in did not finish.' });
          }
          answer();
        });
      });
      this.timer = setTimeout(() => {
        this.child?.kill();
        this.finish({ status: 'expired', error: 'The sign-in expired. Start again.' });
      }, SIGN_IN_LIFETIME_MS);
      // Claude Code prints its link within a few seconds; do not hold the request open forever.
      setTimeout(answer, 20_000);
    });
  }

  /** Pass the code from Claude's sign-in page to the waiting Claude Code. */
  submitCode(code: string): ClaudeSignInState {
    const clean = code.trim();
    if (!this.child?.stdin || this.state.status !== 'waiting') throw new Error('No Claude sign-in is waiting for a code. Start again.');
    if (!clean || clean.length > MAX_CODE_LENGTH || /\s/.test(clean)) throw new Error('Paste the code exactly as Claude shows it.');
    this.child.stdin.write(clean + '\n');
    return this.state;
  }

  cancel(): ClaudeSignInState {
    if (this.child) {
      this.child.kill();
      this.finish({ status: 'signed_out' });
    }
    return this.state;
  }

  private finish(next: ClaudeSignInState) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child = null;
    this.state = next;
  }
}

export const claudeSignIn = new ClaudeSignIn();

