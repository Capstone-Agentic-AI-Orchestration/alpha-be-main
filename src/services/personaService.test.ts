import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Agent } from '../models/index.js';

type Service = typeof import('./personaService.js');

let tmp: string;
let svc: Service;

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent-architect',
  name: 'Ada Lovelace',
  role: 'Architect',
  avatar: '',
  color: '#6366f1',
  description: 'System architect.',
  owner: 'You',
  isMine: true,
  modelProvider: 'Anthropic',
  modelName: 'claude-sonnet-5',
  systemPrompt: 'DB_PROMPT',
  autonomyLevel: 'Semi-Autonomous (Requires Approval)',
  skills: ['sk-fs'],
  mcpServers: ['alpha-github'],
  createdAt: '2026-08-27T00:00:00.000Z',
  ...over
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-persona-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  svc = await import('./personaService.js');
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeAgentFile = (content: string, id = 'agent-architect') => {
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', `${id}.md`), content, 'utf8');
};

const writeMemory = (relative: string, content: string) => {
  const full = path.join(tmp, 'memory', ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
};

describe('resolveAgent — precedence', () => {
  it('falls back to the database row when no file exists', () => {
    const resolved = svc.resolveAgent(agent());

    expect(resolved.systemPrompt).toBe('DB_PROMPT');
    expect(resolved.modelName).toBe('claude-sonnet-5');
    expect(resolved.sources).toEqual(['alpha.db']);
  });

  it('lets the file body win over the database prompt', () => {
    writeAgentFile('---\nname: Ada Lovelace\n---\n\nFILE_PROMPT');

    const resolved = svc.resolveAgent(agent());
    expect(resolved.systemPrompt).toBe('FILE_PROMPT');
    expect(resolved.systemPrompt).not.toContain('DB_PROMPT');
    expect(resolved.sources).toEqual(['agents/agent-architect.md']);
  });

  it('lets file frontmatter win over database columns', () => {
    writeAgentFile('---\nmodel: claude-opus-5\nprovider: OpenAI\n---\n\nFILE_PROMPT');

    const resolved = svc.resolveAgent(agent());
    expect(resolved.modelName).toBe('claude-opus-5');
    expect(resolved.modelProvider).toBe('OpenAI');
  });

  it('keeps database values for fields the file does not declare', () => {
    writeAgentFile('---\nmodel: claude-opus-5\n---\n\nFILE_PROMPT');

    const resolved = svc.resolveAgent(agent());
    expect(resolved.name).toBe('Ada Lovelace');
    expect(resolved.role).toBe('Architect');
    expect(resolved.mcpServers).toEqual(['alpha-github']);
  });

  it('falls back to the database prompt when the file has frontmatter but no body', () => {
    writeAgentFile('---\nmodel: claude-opus-5\n---\n');

    const resolved = svc.resolveAgent(agent());
    expect(resolved.systemPrompt).toBe('DB_PROMPT');
    expect(resolved.modelName).toBe('claude-opus-5');
  });
});

describe('resolveAgent — memory composition', () => {
  it('appends memory after the persona, not before', () => {
    writeAgentFile('---\nname: Ada\n---\n\nFILE_PROMPT');
    writeMemory('global/preferences.md', 'GLOBAL_RULE');

    const { systemPrompt } = svc.resolveAgent(agent());

    expect(systemPrompt.indexOf('FILE_PROMPT')).toBeLessThan(systemPrompt.indexOf('GLOBAL_RULE'));
  });

  it('lists memory files in sources alongside the persona origin', () => {
    writeAgentFile('---\nname: Ada\n---\n\nFILE_PROMPT');
    writeMemory('global/preferences.md', 'GLOBAL_RULE');
    writeMemory('agents/agent-architect/learnings.md', 'AGENT_NOTE');

    expect(svc.resolveAgent(agent()).sources).toEqual([
      'agents/agent-architect.md',
      'global/preferences.md',
      'agents/agent-architect/learnings.md'
    ]);
  });

  it('includes the project tier only when a project key is supplied', () => {
    writeMemory('projects/ALF/rules.md', 'PROJECT_RULE');

    expect(svc.resolveAgent(agent()).systemPrompt).not.toContain('PROJECT_RULE');
    expect(svc.resolveAgent(agent(), { projectKey: 'ALF' }).systemPrompt).toContain(
      'PROJECT_RULE'
    );
  });

  it('skips memory entirely when asked to', () => {
    writeMemory('global/preferences.md', 'GLOBAL_RULE');

    const resolved = svc.resolveAgent(agent(), { includeMemory: false });
    expect(resolved.systemPrompt).toBe('DB_PROMPT');
    expect(resolved.sources).toEqual(['alpha.db']);
  });

  it('produces a memory-only prompt when the agent has no persona at all', () => {
    writeMemory('global/preferences.md', 'GLOBAL_RULE');

    const { systemPrompt } = svc.resolveAgent(agent({ systemPrompt: '' }));
    expect(systemPrompt).toContain('GLOBAL_RULE');
    expect(systemPrompt.trim().startsWith('##')).toBe(true);
  });

  it('returns an empty prompt when there is neither persona nor memory', () => {
    expect(svc.resolveAgent(agent({ systemPrompt: '' })).systemPrompt).toBe('');
  });
});

describe('resolveAgentLogged', () => {
  it('resolves identically and logs what went into the prompt', () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeAgentFile('---\nname: Ada\n---\n\nFILE_PROMPT');

    const resolved = svc.resolveAgentLogged(agent());

    expect(resolved.systemPrompt).toBe('FILE_PROMPT');
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Persona agent-architect'),
      ...([] as unknown[])
    );
  });
});
