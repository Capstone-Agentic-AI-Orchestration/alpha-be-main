import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Skill } from '../models/index.js';

export type DiscoveredSkillSource = 'user' | 'project' | 'plugin' | 'system_detected';

export interface DiscoveredSkill extends Skill {
  source: DiscoveredSkillSource;
  path: string;
  installed: true;
}

export interface SkillDiscoveryRoot {
  path: string;
  source: DiscoveredSkillSource;
  /** A label used to keep IDs stable when two roots contain the same skill. */
  label: string;
  maxDepth?: number;
}

export interface SkillDiscoveryOptions {
  cwd?: string;
  homeDir?: string;
  roots?: SkillDiscoveryRoot[];
  pluginCacheRoots?: string[];
}

interface SkillFileCandidate {
  filePath: string;
  root: SkillDiscoveryRoot;
  pluginName?: string;
  skillNameHint?: string;
  modifiedAtMs: number;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo'
]);

function existingDirectory(candidate: string): string | undefined {
  try {
    if (!fs.statSync(candidate).isDirectory()) return undefined;
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function normalisePath(candidate: string): string {
  return path.resolve(candidate).replace(/[\\/]+$/, '');
}

function uniqueRoots(roots: SkillDiscoveryRoot[]): SkillDiscoveryRoot[] {
  const seen = new Set<string>();
  return roots.filter(root => {
    const resolved = normalisePath(root.path).toLowerCase();
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function ancestors(start: string, max = 5): string[] {
  const result: string[] = [];
  let current = normalisePath(start);
  for (let i = 0; i < max; i += 1) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function defaultRoots(options: SkillDiscoveryOptions): { roots: SkillDiscoveryRoot[]; pluginCacheRoots: string[] } {
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homeDir, '.codex');
  const cwd = options.cwd ?? process.cwd();
  const roots: SkillDiscoveryRoot[] = [];
  const add = (root: SkillDiscoveryRoot) => roots.push(root);

  // Project-local skills are intentionally limited to the current folder and a
  // few parents. Walking an entire drive would be slow and could read unrelated
  // repositories owned by another project.
  for (const ancestor of ancestors(cwd)) {
    if (normalisePath(ancestor).toLowerCase() === normalisePath(homeDir).toLowerCase()) continue;
    const projectLabel = path.basename(ancestor) || ancestor;
    add({ path: path.join(ancestor, '.agents', 'skills'), source: 'project', label: `${projectLabel} · .agents` });
    add({ path: path.join(ancestor, '.codex', 'skills'), source: 'project', label: `${projectLabel} · .codex` });
  }

  // Global user-installed skills used by the Codex and agent-skills loaders.
  add({ path: path.join(homeDir, '.agents', 'skills'), source: 'user', label: 'User · .agents' });
  add({ path: path.join(codexHome, 'skills'), source: 'user', label: 'User · .codex' });
  // CODEX_HOME is commonly used to keep a second Codex profile. Keep the
  // default profile in the scan too when the override points elsewhere.
  if (normalisePath(codexHome).toLowerCase() !== normalisePath(path.join(homeDir, '.codex')).toLowerCase()) {
    add({ path: path.join(homeDir, '.codex', 'skills'), source: 'user', label: 'User · .codex (default)' });
  }

  // Optional extra roots make the detector useful for a team that keeps skill
  // packs outside the conventional folders. Windows uses `;`, POSIX uses `:`.
  for (const configuredRoot of (process.env.ALPHA_SKILL_ROOTS || '').split(path.delimiter)) {
    const trimmed = configuredRoot.trim();
    if (trimmed) add({ path: trimmed, source: 'user', label: 'Configured skill root' });
  }

  // A locally configured Alpha home can also contain project-specific skill
  // packs. It is not assumed to be the user's home directory.
  const alphaHome = process.env.ALPHA_HOME;
  if (alphaHome) add({ path: path.join(alphaHome, 'skills'), source: 'project', label: 'Alpha · skills' });

  const defaultPluginCache = path.join(homeDir, '.codex', 'plugins', 'cache');
  const configuredPluginCacheRoots = [...(options.pluginCacheRoots ?? (options.roots ? [] : [path.join(codexHome, 'plugins', 'cache')]))];
  if (!options.roots && !configuredPluginCacheRoots.some(root => normalisePath(root).toLowerCase() === normalisePath(defaultPluginCache).toLowerCase())
    && normalisePath(codexHome).toLowerCase() !== normalisePath(path.join(homeDir, '.codex')).toLowerCase()) {
    configuredPluginCacheRoots.push(defaultPluginCache);
  }

  return {
    roots: uniqueRoots(roots),
    // Supplying explicit roots is primarily useful for tests and callers that
    // want a bounded scan; do not silently add the real user's plugin cache in
    // that mode unless it was explicitly requested.
    pluginCacheRoots: configuredPluginCacheRoots
  };
}

function findSkillFiles(root: SkillDiscoveryRoot): SkillFileCandidate[] {
  const start = normalisePath(root.path);
  if (!existingDirectory(start)) return [];

  const maxDepth = root.maxDepth ?? 5;
  const result: SkillFileCandidate[] = [];
  const visited = new Set<string>();

  const visit = (directory: string, depth: number) => {
    const realDirectory = existingDirectory(directory);
    if (!realDirectory || visited.has(realDirectory.toLowerCase())) return;
    visited.add(realDirectory.toLowerCase());

    // Keep the caller's lexical path in the catalog. On macOS `/var` is a
    // symlink to `/private/var`; resolving it here makes otherwise identical
    // paths change depending on how the caller reached the directory.
    const skillFile = path.join(directory, 'SKILL.md');
    try {
      const stat = fs.statSync(skillFile);
      if (stat.isFile()) {
        result.push({
          filePath: skillFile,
          root,
          modifiedAtMs: stat.mtimeMs,
          skillNameHint: path.basename(realDirectory)
        });
      }
    } catch {
      // A partially removed or unreadable skill is skipped; the rest of the
      // catalog should remain usable.
    }

    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(realDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      // Do not follow symlinked directories. A plugin cache can contain links
      // back into the home directory and would otherwise recurse indefinitely.
      if (entry.isSymbolicLink()) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };

  visit(start, 0);
  return result;
}

function pluginCandidates(cacheRoot: string): SkillFileCandidate[] {
  const rootPath = existingDirectory(cacheRoot);
  if (!rootPath) return [];
  const displayRoot = normalisePath(cacheRoot);
  const pluginRoot: SkillDiscoveryRoot = {
    path: displayRoot,
    source: 'plugin',
    label: 'Installed plugin',
    maxDepth: 10
  };
  const candidates = findSkillFiles(pluginRoot);

  return candidates.map(candidate => {
    const relativeParts = path.relative(displayRoot, candidate.filePath).split(path.sep).filter(Boolean);
    const skillMarker = relativeParts.findIndex(part => part === 'skills' || part === 'migrated-command-skills');
    const pluginName = relativeParts[1] || relativeParts[0] || 'plugin';
    const skillNameHint = skillMarker >= 0
      ? relativeParts[skillMarker + 1]
      : candidate.skillNameHint;
    return { ...candidate, pluginName, skillNameHint };
  });
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function firstParagraph(content: string): string {
  const withoutFrontmatter = content.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
  const heading = withoutFrontmatter.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  const paragraph = withoutFrontmatter
    .split(/\r?\n\s*\r?\n/)
    .map(part => part.replace(/^\s+|\s+$/g, '').replace(/\r?\n/g, ' '))
    .find(part => part && !part.startsWith('#') && !part.startsWith('```'));
  return (paragraph || heading || '').trim();
}

function parseMetadata(filePath: string, fallbackName: string): { name: string; description: string } {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { name: fallbackName, description: '' };
  }

  const frontmatterMatch = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const metadata = new Map<string, string>();
  if (frontmatterMatch) {
    let activeKey: string | undefined;
    for (const line of frontmatterMatch[1].split(/\r?\n/)) {
      const entry = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (entry) {
        activeKey = entry[1].toLowerCase();
        const scalar = unquote(entry[2]);
        // Support the common YAML folded/literal description forms without
        // pulling a full YAML parser into the daemon.
        metadata.set(activeKey, scalar === '>' || scalar === '|' ? '' : scalar);
      } else if (activeKey === 'description' && /^\s+/.test(line)) {
        const previous = metadata.get(activeKey) || '';
        metadata.set(activeKey, `${previous} ${unquote(line)}`.trim());
      }
    }
  }

  const name = metadata.get('name') || fallbackName;
  const description = (metadata.get('description') || firstParagraph(content)).replace(/\s+/g, ' ').trim();
  return { name, description: description.slice(0, 500) };
}

function slug(value: string): string {
  const output = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return output.slice(0, 56) || 'skill';
}

function stableId(source: DiscoveredSkillSource, key: string): string {
  const digest = createHash('sha1').update(`${source}:${key.toLowerCase()}`).digest('hex').slice(0, 8);
  return `skill-${slug(source)}-${slug(key)}-${digest}`;
}

function inferCategory(name: string, description: string, filePath: string): Skill['category'] {
  const text = `${name} ${description} ${filePath}`.toLowerCase();
  const identity = `${name} ${filePath}`.toLowerCase();
  if (/\b(browser|web|website|screen[- ]reader|playwright|puppeteer|url|http)\b/.test(text)) return 'Browser';
  // "review" and "check" appear in many unrelated skill descriptions. Git is
  // only selected for an explicit repository/branch vocabulary instead.
  if (/(^|[\s/_.-])(git|github|gitlab|pull[- ]request|commit|branch)(?=$|[\s/_.-])/.test(identity)
    || /\b(github|git repository|pull request|git branch|git commit)\b/.test(description.toLowerCase())) return 'Git';
  if (/\b(file|document|pdf|spreadsheet|sheet|slide|docx|image|asset|drive)\b/.test(text)) return 'File Operations';
  if (/\b(terminal|shell|cli|command|bash|powershell|exec|runtime)\b/.test(text)) return 'Terminal';
  if (/\b(mcp|api|cloud|supabase|slack|openai|connector|google)\b/.test(text)) return 'MCP Servers';
  return 'Agent Skills';
}

function sourceForCandidate(candidate: SkillFileCandidate): DiscoveredSkillSource {
  if (candidate.root.source !== 'user') return candidate.root.source;
  const relative = path.relative(candidate.root.path, candidate.filePath).split(path.sep).filter(Boolean);
  // `.codex/skills/.system` is shipped with Codex itself, not a user skill.
  if (relative[0] === '.system') return 'system_detected';
  return candidate.root.source;
}

function candidateKey(candidate: SkillFileCandidate, name: string): string {
  if (candidate.root.source === 'plugin') return `plugin:${candidate.pluginName || 'plugin'}:${name}`;
  return `${candidate.root.label}:${name}`;
}

function toDiscoveredSkill(candidate: SkillFileCandidate): DiscoveredSkill {
  const fallbackName = candidate.skillNameHint || path.basename(path.dirname(candidate.filePath));
  const metadata = parseMetadata(candidate.filePath, fallbackName);
  const source = sourceForCandidate(candidate);
  const key = candidateKey(candidate, metadata.name);
  return {
    id: stableId(source, key),
    name: metadata.name,
    category: inferCategory(metadata.name, metadata.description, candidate.filePath),
    permissions: 'read_only',
    description: metadata.description || `Installed skill from ${candidate.root.label}.`,
    isEnabled: true,
    source,
    path: candidate.filePath,
    installed: true
  };
}

/**
 * Enumerate installed SKILL.md files from the roots used by Codex and the
 * agent-skills loader. This is deliberately filesystem-only: it never executes
 * a skill or treats its prose as an instruction to Alpha.
 */
export function discoverInstalledSkills(options: SkillDiscoveryOptions = {}): DiscoveredSkill[] {
  const defaults = defaultRoots(options);
  const roots = uniqueRoots(options.roots ?? defaults.roots);
  const candidates = roots.flatMap(findSkillFiles);
  for (const cacheRoot of defaults.pluginCacheRoots) candidates.push(...pluginCandidates(cacheRoot));

  const deduped = new Map<string, SkillFileCandidate>();
  for (const candidate of candidates) {
    const fallbackName = candidate.skillNameHint || path.basename(path.dirname(candidate.filePath));
    const metadata = parseMetadata(candidate.filePath, fallbackName);
    const source = sourceForCandidate(candidate);
    const key = candidateKey(candidate, metadata.name).toLowerCase();
    const existing = deduped.get(`${source}:${key}`);
    // When a plugin has multiple cached versions, retain the newest file. For
    // project/user collisions the first configured root wins deterministically.
    if (!existing || candidate.modifiedAtMs > existing.modifiedAtMs) deduped.set(`${source}:${key}`, candidate);
  }

  return [...deduped.values()]
    .map(toDiscoveredSkill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
