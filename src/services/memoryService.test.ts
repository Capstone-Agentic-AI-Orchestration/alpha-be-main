import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Service = typeof import('./memoryService.js');

let tmp: string;
let svc: Service;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-memory-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  svc = await import('./memoryService.js');
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const memPath = (...parts: string[]) => path.join(tmp, 'memory', ...parts);

const write = (relative: string, content: string) => {
  const full = memPath(...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};

describe('ensureMemoryScaffold', () => {
  it('creates the global tier', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    svc.ensureMemoryScaffold();

    for (const file of ['preferences.md', 'patterns.md', 'mistakes.md']) {
      expect(fs.existsSync(memPath('global', file))).toBe(true);
    }
  });

  it('creates the project and agent tiers on request', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    svc.ensureMemoryScaffold({ projectKey: 'ALF', agentId: 'agent-architect' });

    expect(fs.existsSync(memPath('projects', 'ALF', 'rules.md'))).toBe(true);
    expect(fs.existsSync(memPath('projects', 'ALF', 'architecture.md'))).toBe(true);
    expect(fs.existsSync(memPath('agents', 'agent-architect', 'learnings.md'))).toBe(true);
  });

  it('never overwrites an existing file', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    write('global/preferences.md', 'MY OWN CONTENT');

    svc.ensureMemoryScaffold();

    expect(fs.readFileSync(memPath('global', 'preferences.md'), 'utf8')).toBe('MY OWN CONTENT');
  });

  it('is idempotent — a second call creates nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(svc.ensureMemoryScaffold()).toBeGreaterThan(0);
    expect(svc.ensureMemoryScaffold()).toBe(0);
  });

  it('does not throw for an unsafe project key', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => svc.ensureMemoryScaffold({ projectKey: '../escape' })).not.toThrow();
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
  });
});

describe('hasContent', () => {
  it('is false for a comment-only template', () => {
    expect(svc.hasContent('# Title\n\n<!--\n  guidance here\n-->\n')).toBe(false);
  });

  it('is false for headings alone', () => {
    expect(svc.hasContent('# Title\n\n## Section\n')).toBe(false);
  });

  it('is false for whitespace', () => {
    expect(svc.hasContent('   \n\n\t\n')).toBe(false);
  });

  it('is true once real prose is present', () => {
    expect(svc.hasContent('# Title\n\n<!-- guidance -->\n\nUse strict mode.')).toBe(true);
  });
});

describe('composeMemory', () => {
  it('returns nothing when no memory exists', () => {
    expect(svc.composeMemory({})).toEqual({ text: '', sources: [], totalChars: 0 });
  });

  it('returns nothing when only untouched templates exist', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    svc.ensureMemoryScaffold({ projectKey: 'ALF', agentId: 'agent-architect' });

    const block = svc.composeMemory({ projectKey: 'ALF', agentId: 'agent-architect' });
    expect(block.text).toBe('');
    expect(block.sources).toEqual([]);
  });

  it('includes a global file that has content', () => {
    write('global/preferences.md', '# User preferences\n\nUse TypeScript strict mode.');

    const block = svc.composeMemory({});
    expect(block.text).toContain('Use TypeScript strict mode.');
    expect(block.sources).toEqual(['global/preferences.md']);
  });

  it('orders tiers global then project then agent', () => {
    write('global/preferences.md', 'GLOBAL_MARKER');
    write('projects/ALF/rules.md', 'PROJECT_MARKER');
    write('agents/agent-architect/learnings.md', 'AGENT_MARKER');

    const { text, sources } = svc.composeMemory({ projectKey: 'ALF', agentId: 'agent-architect' });

    expect(text.indexOf('GLOBAL_MARKER')).toBeLessThan(text.indexOf('PROJECT_MARKER'));
    expect(text.indexOf('PROJECT_MARKER')).toBeLessThan(text.indexOf('AGENT_MARKER'));
    expect(sources).toEqual([
      'global/preferences.md',
      'projects/ALF/rules.md',
      'agents/agent-architect/learnings.md'
    ]);
  });

  it('omits the project tier when no project key is given', () => {
    write('projects/ALF/rules.md', 'PROJECT_MARKER');

    expect(svc.composeMemory({}).text).not.toContain('PROJECT_MARKER');
  });

  it('strips HTML comments so guidance is not sent to the model', () => {
    write('global/preferences.md', '<!-- internal note -->\n\nUse strict mode.');

    const { text } = svc.composeMemory({});
    expect(text).toContain('Use strict mode.');
    expect(text).not.toContain('internal note');
  });

  it('labels each section so the model knows which tier it came from', () => {
    write('global/mistakes.md', 'Never pass --system-prompt.');

    expect(svc.composeMemory({}).text).toContain('### Known mistakes to avoid');
  });

  it('truncates a file past the per-file cap, keeping both ends', async () => {
    const { MEMORY_LIMITS } = await import('../config/constants.js');
    write(
      'global/patterns.md',
      `HEAD_MARKER\n${'x'.repeat(MEMORY_LIMITS.MAX_CHARS_PER_FILE * 2)}\nTAIL_MARKER`
    );

    const { text } = svc.composeMemory({});
    expect(text).toContain('HEAD_MARKER');
    expect(text).toContain('TAIL_MARKER');
    expect(text).toContain('memory truncated');
  });

  it('stops adding files at the total cap and logs what it dropped', async () => {
    const { MEMORY_LIMITS } = await import('../config/constants.js');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const bulk = 'y'.repeat(MEMORY_LIMITS.MAX_CHARS_PER_FILE);
    write('global/preferences.md', bulk);
    write('global/patterns.md', bulk);
    write('global/mistakes.md', bulk);
    write('agents/agent-architect/learnings.md', `${bulk}\nDROPPED_MARKER`);

    const { text, totalChars } = svc.composeMemory({ agentId: 'agent-architect' });

    expect(totalChars).toBeLessThanOrEqual(MEMORY_LIMITS.MAX_CHARS_TOTAL + 200);
    expect(text).not.toContain('DROPPED_MARKER');
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('Memory budget exhausted'),
      expect.stringContaining('agents/agent-architect/learnings.md')
    );
  });

  it('does not throw for an unsafe agent id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => svc.composeMemory({ agentId: '../escape' })).not.toThrow();
  });
});

describe('path helpers', () => {
  it.each(['../escape', 'nested/key', 'back\\slash', '.', '..', ''])(
    'rejects the unsafe project key %j',
    key => {
      expect(() => svc.projectMemoryDir(key)).toThrow(/Invalid project key/);
    }
  );

  it('builds the documented layout', () => {
    expect(svc.globalMemoryDir()).toBe(memPath('global'));
    expect(svc.projectMemoryDir('ALF')).toBe(memPath('projects', 'ALF'));
    expect(svc.agentMemoryDir('agent-architect')).toBe(memPath('agents', 'agent-architect'));
  });
});
