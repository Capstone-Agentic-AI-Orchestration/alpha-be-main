import crossSpawn from 'cross-spawn';
import { RuntimeService } from './runtimeService.js';
import { childProcessEnv } from './childProcessEnv.js';
import { logError } from '../utils/logger.js';

/**
 * Sign-in for runtimes whose CLI only signs in interactively.
 *
 * Antigravity (`agy`) has no sign-in command: it asks the person to sign in
 * when it starts. OpenCode signs in through a menu (`opencode auth login`).
 * Neither can be driven from a background process, so Alpha opens the command
 * in its own terminal window on this desktop and the person signs in there.
 * The CLI keeps its credentials itself; Alpha never sees them.
 */
const SIGN_IN_COMMANDS: Record<string, () => { bin: string; args: string[] }> = {
  antigravity: () => ({ bin: RuntimeService.agyPath(), args: [] }),
  opencode: () => ({ bin: RuntimeService.opencodePath(), args: ['auth', 'login'] })
};

export class SignInWindowError extends Error {
  constructor(message: string, readonly status: 400 | 501) {
    super(message);
  }
}

export function opensSignInWindow(id: string): boolean {
  return id in SIGN_IN_COMMANDS;
}

/** Open the runtime's sign-in in a new terminal window. Windows only: the desktop app ships for Windows. */
export function openSignInWindow(id: string): void {
  const command = SIGN_IN_COMMANDS[id];
  if (!command) throw new SignInWindowError(`${id} signs in another way.`, 400);
  if (process.platform !== 'win32') throw new SignInWindowError('Opening a sign-in window is supported on Windows only.', 501);

  const { bin, args } = command();
  // A detached console program on Windows gets its own console window.
  const child = crossSpawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: childProcessEnv()
  });
  child.on('error', err => logError(`Could not open the ${id} sign-in window: ${String(err)}`));
  child.unref();
}

