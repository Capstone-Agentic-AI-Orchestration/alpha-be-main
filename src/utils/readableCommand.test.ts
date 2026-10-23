import { describe, expect, it } from 'vitest';
import { readableCommand } from './readableCommand.js';

describe('commands in the activity feed', () => {
  it('shows what ran inside the shell, without the launch line or escaped backslashes', () => {
    expect(readableCommand(String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git diff --check; git status --short'`))
      .toBe('git diff --check; git status --short');
    expect(readableCommand(['/bin/bash', '-lc', 'npm test'])).toBe('npm test');
    expect(readableCommand(String.raw`Get-Content C:\\repo\\src\\app.ts`)).toBe(String.raw`Get-Content C:\repo\src\app.ts`);
  });

  it('leaves a plain command alone', () => {
    expect(readableCommand('npm run lint')).toBe('npm run lint');
  });
});

