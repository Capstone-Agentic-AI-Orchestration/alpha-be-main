/**
 * A command as a person would type it, for the activity feed. Agent CLIs report the
 * full shell launch, such as "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '...',
 * with escaped backslashes; the feed only needs what ran inside the shell.
 */
const SHELL_LAUNCH = /^\s*(?:"[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"|\S*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?)\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i;

export function readableCommand(command: unknown): string {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    const flag = parts.findIndex(part => /^(?:-Command|-lc|-c|\/c)$/i.test(part));
    return readableCommand(flag >= 0 && flag < parts.length - 1 ? parts.slice(flag + 1).join(' ') : parts.join(' '));
  }
  let text = String(command ?? '').trim();
  const launch = SHELL_LAUNCH.exec(text);
  if (launch) {
    text = launch[1].trim();
    const quote = text[0];
    if ((quote === "'" || quote === '"') && text.endsWith(quote) && text.length > 1) text = text.slice(1, -1);
  }
  return text.replace(/\\\\/g, '\\');
}

