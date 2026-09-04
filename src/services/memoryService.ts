import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_DIR } from '../config/env.js';
import { MEMORY_LIMITS } from '../config/constants.js';
import { toPromptText, hasProse } from '../utils/frontmatter.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * The three memory tiers from AGENTS_AND_MEMORIES_PLAN.md §3.
 *
 *   ~/.alpha/memory/
 *   ├── global/                    Tier 1 — every agent, every project
 *   │   ├── preferences.md
 *   │   ├── patterns.md
 *   │   └── mistakes.md
 *   ├── projects/{KEY}/            Tier 2 — one project
 *   │   ├── architecture.md
 *   │   ├── rules.md
 *   │   └── decisions.md
 *   └── agents/{AGENT_ID}/         Tier 3 — one agent
 *       └── learnings.md
 *
 * The plan described this as read on every run and never implemented it —
 * `MEMORY_DIR` was exported from config/env.ts and referenced nowhere. Tier 3 as
 * described in the plan ("SQLite, real-time") already exists as chat_messages;
 * what was missing is the durable markdown that survives a thread.
 *
 * ## Empty files contribute nothing
 *
 * Every seeded file arrives with guidance in an HTML comment. `hasContent`
 * ignores comments and headings, so a fresh install adds zero characters to a
 * prompt — the scaffolding exists to be discoverable in a file browser, not to
 * be sent to a model.
 */

export type MemoryTier = 'global' | 'project' | 'agent';

export interface MemoryFile {
  tier: MemoryTier;
  /** Display label used as the section heading in the composed prompt. */
  label: string;
  /** Path relative to MEMORY_DIR, for logging and for the `sources` list. */
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface MemoryBlock {
  /** Markdown ready to append to a system prompt. Empty when nothing was found. */
  text: string;
  /** Relative paths that contributed, in prompt order. */
  sources: string[];
  totalChars: number;
}

const GLOBAL_FILES = [
  { file: 'preferences.md', label: 'User preferences' },
  { file: 'patterns.md', label: 'Proven patterns' },
  { file: 'mistakes.md', label: 'Known mistakes to avoid' }
] as const;

const PROJECT_FILES = [
  { file: 'architecture.md', label: 'Project architecture' },
  { file: 'rules.md', label: 'Project ground rules' },
  { file: 'decisions.md', label: 'Architecture decisions' }
] as const;

const AGENT_FILES = [{ file: 'learnings.md', label: 'Your accumulated learnings' }] as const;

function templateFor(label: string, purpose: string, examples: string[]): string {
  return [
    `# ${label}`,
    '',
    '<!--',
    `  ${purpose}`,
    '',
    '  Anything you write below the comment is appended to the system prompt of',
    '  every agent run this tier applies to. Keep it short and imperative —',
    '  it is paid for on every request.',
    '',
    '  Examples of what belongs here:',
    ...examples.map(e => `    - ${e}`),
    '',
    '  While this file contains only this comment it is skipped entirely and',
    '  costs nothing.',
    '-->',
    ''
  ].join('\n');
}

const TEMPLATES: Record<string, string> = {
  'global/preferences.md': templateFor(
    'User preferences',
    'Cross-project preferences that apply to every agent on this machine.',
    [
      'Use TypeScript strict mode; never `any` in new code.',
      'Prefer composition over inheritance.',
      'Do not add code comments that restate the code.'
    ]
  ),
  'global/patterns.md': templateFor(
    'Proven patterns',
    'Approaches that have worked more than once and should be reused.',
    [
      'Validate request bodies with zod at the controller boundary.',
      'Wrap CLI spawns in processManager so cancellation works.'
    ]
  ),
  'global/mistakes.md': templateFor(
    'Known mistakes to avoid',
    'Errors already made once. The point of this file is not making them twice.',
    [
      'Never pass --system-prompt to claude; it replaces the default prompt.',
      'stream-json output requires --verbose or the CLI exits 1.'
    ]
  ),
  'project/architecture.md': templateFor(
    'Project architecture',
    'How this specific project is laid out and what depends on what.',
    ['Backend is Express + better-sqlite3; no ORM.', 'Frontend state lives in AppContext.']
  ),
  'project/rules.md': templateFor(
    'Project ground rules',
    'Commands, conventions and constraints specific to this project.',
    ['Tests: npm test (vitest).', 'Never edit files under dist/.']
  ),
  'project/decisions.md': templateFor(
    'Architecture decisions',
    'Decisions taken, with the reason, so they are not silently reversed.',
    ['Chose SQLite over Postgres for solo mode — no server to run.']
  ),
  'agent/learnings.md': templateFor(
    'Accumulated learnings',
    'Notes this agent should carry between conversations.',
    ['The auth middleware is in src/middleware/auth.ts, not src/auth/.']
  )
};

export function memoryRoot(): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  return MEMORY_DIR;
}

/**
 * Reject a value used as one path segment.
 *
 * Project keys and agent ids reach here from request bodies, so a separator or
 * '..' would read and create directories outside the memory root.
 */
function assertSegment(segment: string, label: string): string {
  const valid =
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment.length <= 120 &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    segment !== '.' &&
    segment !== '..';

  if (!valid) throw new Error(`Invalid ${label} "${segment}" for a memory path.`);
  return segment;
}

export function globalMemoryDir(): string {
  return path.join(MEMORY_DIR, 'global');
}

export function projectMemoryDir(projectKey: string): string {
  return path.join(MEMORY_DIR, 'projects', assertSegment(projectKey, 'project key'));
}

export function agentMemoryDir(agentId: string): string {
  return path.join(MEMORY_DIR, 'agents', assertSegment(agentId, 'agent id'));
}

/**
 * True when a file has prose beyond its scaffolding.
 *
 * Shared with the persona files — see `hasProse` — so that "is this file
 * actually saying anything" means the same thing in both layers.
 */
export const hasContent = hasProse;

/**
 * Trim an over-long memory file, keeping both ends.
 *
 * Head and tail rather than either alone: these files accumulate top-down for
 * foundational rules and bottom-up for recent learnings, and there is no way to
 * tell which a given file is doing. Dropping the middle keeps the framing and
 * the newest entries, and says so where the cut happened so the model does not
 * treat the result as complete.
 */
function capChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };

  const keep = Math.floor((max - 80) / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);

  return {
    text: `${head}\n\n... [memory truncated — ${text.length - keep * 2} characters omitted] ...\n\n${tail}`,
    truncated: true
  };
}

function readMemoryFile(
  dir: string,
  file: string,
  tier: MemoryTier,
  label: string
): MemoryFile | null {
  const full = path.join(dir, file);

  let raw: string;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logError(`Could not read memory file ${full}`, err?.message ?? String(err));
    }
    return null;
  }

  if (!hasContent(raw)) return null;

  const cleaned = toPromptText(raw)
    .split('\n')
    // Drop the template's own H1 so the composed prompt supplies the heading.
    .filter((line, i) => !(i === 0 && line.trimStart().startsWith('# ')))
    .join('\n')
    .trim();

  const { text, truncated } = capChars(cleaned, MEMORY_LIMITS.MAX_CHARS_PER_FILE);

  return {
    tier,
    label,
    relativePath: path.relative(MEMORY_DIR, full).replace(/\\/g, '/'),
    content: text,
    truncated
  };
}

export interface MemoryQuery {
  agentId?: string;
  /** `Project.key`, e.g. 'ALF'. Omitted for chats, which belong to no project. */
  projectKey?: string;
}

/** Every non-empty memory file that applies, in prompt order: global → project → agent. */
export function collectMemory(query: MemoryQuery): MemoryFile[] {
  const found: MemoryFile[] = [];

  for (const { file, label } of GLOBAL_FILES) {
    const hit = readMemoryFile(globalMemoryDir(), file, 'global', label);
    if (hit) found.push(hit);
  }

  if (query.projectKey) {
    try {
      const dir = projectMemoryDir(query.projectKey);
      for (const { file, label } of PROJECT_FILES) {
        const hit = readMemoryFile(dir, file, 'project', label);
        if (hit) found.push(hit);
      }
    } catch (err: any) {
      logError('Skipping project memory', err?.message ?? String(err));
    }
  }

  if (query.agentId) {
    try {
      const dir = agentMemoryDir(query.agentId);
      for (const { file, label } of AGENT_FILES) {
        const hit = readMemoryFile(dir, file, 'agent', label);
        if (hit) found.push(hit);
      }
    } catch (err: any) {
      logError('Skipping agent memory', err?.message ?? String(err));
    }
  }

  return found;
}

/**
 * Render the applicable memory into one markdown block.
 *
 * Stops adding files once the total cap is reached rather than truncating the
 * last one further, and logs what it dropped — a silently shortened prompt is
 * how an agent starts ignoring a rule nobody realises it can no longer see.
 */
export function composeMemory(query: MemoryQuery): MemoryBlock {
  const files = collectMemory(query);
  if (!files.length) return { text: '', sources: [], totalChars: 0 };

  const sections: string[] = [];
  const sources: string[] = [];
  let total = 0;
  const skipped: string[] = [];

  for (const file of files) {
    const section = `### ${file.label}\n\n${file.content}`;

    if (total + section.length > MEMORY_LIMITS.MAX_CHARS_TOTAL) {
      skipped.push(file.relativePath);
      continue;
    }

    sections.push(section);
    sources.push(file.relativePath);
    total += section.length;
  }

  if (skipped.length) {
    logError(
      'Memory budget exhausted — files omitted from this prompt',
      skipped.join(', ')
    );
  }

  if (!sections.length) return { text: '', sources: [], totalChars: 0 };

  const text = [
    '## Standing context',
    '',
    'The following applies to this machine, project and agent. Treat it as',
    'instruction, not conversation history.',
    '',
    sections.join('\n\n')
  ].join('\n');

  return { text, sources, totalChars: text.length };
}

function writeIfMissing(full: string, content: string): boolean {
  if (fs.existsSync(full)) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return true;
}

/**
 * Create the global tier and, when asked, a project or agent tier.
 *
 * Idempotent — an existing file is never rewritten, so a user's own content is
 * safe across restarts.
 */
export function ensureMemoryScaffold(query: MemoryQuery = {}): number {
  let created = 0;

  try {
    memoryRoot();

    for (const { file } of GLOBAL_FILES) {
      const key = `global/${file}`;
      if (writeIfMissing(path.join(globalMemoryDir(), file), TEMPLATES[key])) created++;
    }

    if (query.projectKey) {
      const dir = projectMemoryDir(query.projectKey);
      for (const { file } of PROJECT_FILES) {
        if (writeIfMissing(path.join(dir, file), TEMPLATES[`project/${file}`])) created++;
      }
    }

    if (query.agentId) {
      const dir = agentMemoryDir(query.agentId);
      for (const { file } of AGENT_FILES) {
        if (writeIfMissing(path.join(dir, file), TEMPLATES[`agent/${file}`])) created++;
      }
    }
  } catch (err: any) {
    logError('Could not scaffold memory directories', err?.message ?? String(err));
    return created;
  }

  if (created) logInfo(`Created ${created} memory file(s) under ${MEMORY_DIR}`);
  return created;
}
