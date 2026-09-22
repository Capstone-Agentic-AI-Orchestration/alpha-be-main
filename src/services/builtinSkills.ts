import type { Skill } from '../models/index.js';

/**
 * The capabilities Alpha itself grants an agent, as opposed to skill files
 * found on a machine.
 *
 * One list for both places that need it: the desktop seeds its catalog from
 * it, and the cloud serves it as the whole catalog, since the skills found by
 * scanning a disk are found on a developer's disk and not on Render's.
 * `toolPolicy`'s SKILL_TOOLS is keyed by these ids.
 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  { id: 'sk-fs', name: 'Filesystem Operations', category: 'File Operations', permissions: 'write', description: 'Read, write, create, delete, and grep files within project directory.', isEnabled: true, commandExample: 'fs.read_file("src/index.ts")' },
  { id: 'sk-bash', name: 'Terminal & Shell', category: 'Terminal', permissions: 'full_execution', description: 'Execute terminal commands (e.g. npm test, vitest, tsc, cargo build).', isEnabled: true, commandExample: 'bash.exec("npm test")' },
  { id: 'sk-git', name: 'Git & GitHub', category: 'Git', permissions: 'write', description: 'Create branches, stage files, commit changes, create PRs, and inspect diffs.', isEnabled: true, commandExample: 'git.diff()' },
  { id: 'sk-browser', name: 'Web & Headless Browser', category: 'Browser', permissions: 'read_only', description: 'Fetch documentation, query web endpoints, and parse markdown.', isEnabled: true, commandExample: 'browser.fetch("https://docs.anthropic.com")' },
  { id: 'sk-code-exec', name: 'Code Execution Sandbox', category: 'Code Execution', permissions: 'full_execution', description: 'Run isolated scripts to verify algorithms or test patches.', isEnabled: true, commandExample: 'code.eval("Math.max(1, 2)")' }
];
