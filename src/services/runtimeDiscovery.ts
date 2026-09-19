import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Check if an executable exists on the system PATH without spawning a subshell.
 */
function findOnPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const delimiter = path.delimiter;
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  const extensions = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return candidate;
          }
        }
      } catch {
        // Permission denied or unreadable path, continue
      }
    }
  }

  return null;
}

/**
 * Find a binary in a versioned per-user installation directory.
 *
 * Desktop installers commonly put the executable below a directory whose
 * name changes on every upgrade. Returning the absolute path matters here:
 * the daemon is not guaranteed to inherit the same PATH as the user's shell.
 */
function findInVersionedDirectories(baseDir: string, relativePath: string): string | null {
  if (!baseDir || !fs.existsSync(baseDir)) return null;

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const directory of directories) {
      const candidate = path.join(baseDir, directory, relativePath);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // A directory can disappear during an upgrade; keep looking.
      }
    }
  } catch {
    // Directory unreadable; the ordinary candidates still get a chance.
  }

  return null;
}

/**
 * Dynamically find Claude Code executable inside macOS Application Support.
 * Claude Code desktop installs inside versioned directories, e.g.:
 * ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude
 */
function findMacClaudeApp(): string | null {
  if (!isMac) return null;
  const baseDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  if (!fs.existsSync(baseDir)) return null;

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const versions = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of versions) {
      const binary = path.join(baseDir, version, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (fs.existsSync(binary)) {
        return binary;
      }
    }
  } catch {
    // Directory unreadable
  }

  return null;
}

/**
 * Discover Claude Code binary.
 * Priority: CLAUDE_PATH -> PATH -> App Bundle -> Common Install Dirs.
 */
export function findClaude(): string {
  if (process.env.CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_PATH)) {
    return process.env.CLAUDE_PATH;
  }

  const defaultName = isWin ? 'claude.cmd' : 'claude';
  const onPath = findOnPath('claude');
  if (onPath) return onPath;

  if (isWin) {
    const versioned = findInVersionedDirectories(
      path.join(process.env.LOCALAPPDATA || '', 'fnm_multishells'),
      'claude.cmd'
    );
    if (versioned) return versioned;
  }

  // macOS Desktop App Bundle
  const macAppClaude = findMacClaudeApp();
  if (macAppClaude) return macAppClaude;

  // Platform candidates
  const candidates = isWin
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Claude', 'claude.exe'),
        path.join(os.homedir(), '.local', 'bin', 'claude.exe')
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(os.homedir(), '.npm-global', 'bin', 'claude')
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

/**
 * Discover OpenAI Codex binary.
 * Priority: CODEX_PATH -> PATH -> ChatGPT Desktop -> Common Install Dirs.
 */
export function findCodex(): string {
  if (process.env.CODEX_PATH && fs.existsSync(process.env.CODEX_PATH)) {
    return process.env.CODEX_PATH;
  }

  const defaultName = isWin ? 'codex.cmd' : 'codex';
  const onPath = findOnPath('codex');
  if (onPath) return onPath;

  if (isWin) {
    const versioned = findInVersionedDirectories(
      path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
      'codex.exe'
    );
    if (versioned) return versioned;
  }

  const candidates = isWin
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ChatGPT', 'resources', 'codex.exe'),
        path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
        path.join(os.homedir(), '.local', 'bin', 'codex.exe')
      ]
    : [
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        path.join(os.homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
        path.join(os.homedir(), '.local', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex'
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

/**
 * Discover Google Antigravity binary (`agy`).
 * Priority: AGY_PATH -> PATH -> App Bundle -> Local Install Dirs.
 */
export function findAntigravity(): string {
  if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) {
    return process.env.AGY_PATH;
  }

  const defaultName = isWin ? 'agy.exe' : 'agy';
  const onPath = findOnPath('agy');
  if (onPath) return onPath;

  const candidates = isWin
    ? [
        path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
          'agy', 'bin', 'agy.exe'
        ),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Antigravity', 'agy.exe'),
        path.join(os.homedir(), '.local', 'bin', 'agy.exe')
      ]
    : [
        path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'bin', 'agy'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy'),
        '/Applications/Google Antigravity.app/Contents/MacOS/agy',
        path.join(os.homedir(), 'Applications', 'Google Antigravity.app', 'Contents', 'MacOS', 'agy'),
        path.join(os.homedir(), '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy'
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

/**
 * Discover Google Gemini CLI binary (`gemini`).
 * Priority: GEMINI_PATH -> PATH -> Common Install Dirs.
 */
export function findGemini(): string {
  if (process.env.GEMINI_PATH && fs.existsSync(process.env.GEMINI_PATH)) {
    return process.env.GEMINI_PATH;
  }

  const defaultName = isWin ? 'gemini.cmd' : 'gemini';
  const onPath = findOnPath('gemini');
  if (onPath) return onPath;

  const candidates = isWin
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Gemini', 'gemini.exe'),
        path.join(os.homedir(), '.local', 'bin', 'gemini.exe')
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'gemini'),
        '/opt/homebrew/bin/gemini',
        '/usr/local/bin/gemini',
        path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Gemini', 'bin', 'gemini')
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

/**
 * Discover OpenCode binary (`opencode`).
 * Priority: OPENCODE_PATH -> PATH -> Common Install Dirs.
 */
export function findOpenCode(): string {
  if (process.env.OPENCODE_PATH && fs.existsSync(process.env.OPENCODE_PATH)) {
    return process.env.OPENCODE_PATH;
  }

  const defaultName = isWin ? 'opencode.cmd' : 'opencode';
  const onPath = findOnPath('opencode');
  if (onPath) return onPath;

  const candidates = isWin
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenCode', 'opencode.exe'),
        path.join(os.homedir(), '.local', 'bin', 'opencode.exe')
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode'
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultName;
}

/**
 * Discover the LM Studio CLI (`lms`). It is shipped with LM Studio but is not
 * always added to PATH for per-user Windows installs.
 *
 * Priority: LMSTUDIO_PATH -> PATH -> the documented per-user CLI locations.
 */
export function findLMStudio(): string {
  if (process.env.LMSTUDIO_PATH && fs.existsSync(process.env.LMSTUDIO_PATH)) {
    return process.env.LMSTUDIO_PATH;
  }

  const defaultName = isWin ? 'lms.exe' : 'lms';
  const onPath = findOnPath('lms');
  if (onPath) return onPath;

  const home = os.homedir();
  const candidates = isWin
    ? [
        path.join(home, '.cache', 'lm-studio', 'bin', 'lms.exe'),
        path.join(home, '.lmstudio', 'bin', 'lms.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'LM-Studio', 'bin', 'lms.exe')
      ]
    : [
        path.join(home, '.cache', 'lm-studio', 'bin', 'lms'),
        path.join(home, '.cache', 'lm-studio', 'bin', 'LMS'),
        path.join(home, '.lmstudio', 'bin', 'lms'),
        path.join(home, '.lmstudio', 'bin', 'LMS'),
        '/usr/local/bin/lms',
        '/opt/homebrew/bin/lms'
      ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return defaultName;
}
