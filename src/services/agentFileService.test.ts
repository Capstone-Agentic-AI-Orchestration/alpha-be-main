import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Agent } from '../models/index.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

/**
 * These tests write real files, so ALPHA_HOME is pointed at a temp directory
 * before the module graph is loaded — `config/env.ts` resolves its paths once at
 * import time, which is why each test re-imports rather than importing at the
 * top of the file.
 */
type Service = typeof import('./agentFileService.js');

let tmp: string;
let svc: Service;

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent-architect',
  name: 'Ada Lovelace',
  role: 'Architect',
  avatar: 'https://example.test/ada.png',
  color: '#6366f1',
  description: 'System architect.',
  owner: 'You',
  isMine: true,
  modelProvider: 'Anthropic',
  modelName: 'claude-sonnet-5',
  systemPrompt: 'You are Ada, a master software architect.',
  autonomyLevel: 'Semi-Autonomous (Requires Approval)',
  skills: ['sk-fs', 'sk-git'],
  mcpServers: ['alpha-github'],
  createdAt: '2026-08-27T00:00:00.000Z',
  ...over
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-agentfile-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  svc = await import('./agentFileService.js');
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const readFile = (id = 'agent-architect') => fs.readFileSync(path.join(tmp, 'agents', `${id}.md`), 'utf8');
const writeFile = (content: string, id = 'agent-architect') => {
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', `${id}.md`), content, 'utf8');
};

describe('syncAgentFile', () => {
  it('writes a persona file carrying the agent config as frontmatter', () => {
    svc.syncAgentFile(agent(), 'replace');

    const { data, body } = parseFrontmatter(readFile());
    expect(data.name).toBe('Ada Lovelace');
    expect(data.role).toBe('Architect');
    expect(data.provider).toBe('Anthropic');
    expect(data.model).toBe('claude-sonnet-5');
    expect(data.skills).toEqual(['sk-fs', 'sk-git']);
    expect(body).toContain('You are Ada, a master software architect.');
  });

  it('preserves a hand-written body while refreshing frontmatter', () => {
    writeFile('---\nname: Ada Lovelace\nmodel: old-model\n---\n\nA long hand-written persona.');

    svc.syncAgentFile(agent({ modelName: 'claude-opus-5' }), 'preserve');

    const { data, body } = parseFrontmatter(readFile());
    expect(data.model).toBe('claude-opus-5');
    expect(body).toBe('A long hand-written persona.');
  });

  it('replaces the body when the caller says the prompt changed', () => {
    writeFile('---\nname: Ada Lovelace\n---\n\nA long hand-written persona.');

    svc.syncAgentFile(agent({ systemPrompt: 'Brand new prompt.' }), 'replace');

    expect(parseFrontmatter(readFile()).body).toContain('Brand new prompt.');
    expect(readFile()).not.toContain('hand-written persona');
  });

  it('creates a starter body when preserving against a file that does not exist', () => {
    svc.syncAgentFile(agent(), 'preserve');
    expect(parseFrontmatter(readFile()).body).toContain('You are Ada');
  });

  it('omits frontmatter keys the agent has no value for', () => {
    svc.syncAgentFile(agent({ temperature: undefined }), 'replace');
    expect(readFile()).not.toContain('temperature:');
  });

  it('returns null instead of throwing when the path cannot be written', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(svc.syncAgentFile(agent(), 'replace')).toBeNull();
  });
});

describe('readAgentFile', () => {
  it('returns null when there is no file', () => {
    expect(svc.readAgentFile('agent-nobody')).toBeNull();
  });

  it('reads the body as the system prompt', () => {
    writeFile('---\nname: Ada\n---\n\nThe real persona, written by hand.');
    expect(svc.readAgentFile('agent-architect')?.systemPrompt).toBe(
      'The real persona, written by hand.'
    );
  });

  it('maps file keys onto Agent field names', () => {
    writeFile(
      [
        '---',
        'name: Ada Reborn',
        'role: Reviewer',
        'provider: OpenAI',
        'model: codex',
        'autonomy: Supervised',
        'temperature: 0.2',
        'skills: [sk-fs]',
        'mcpServers: [alpha-github, filesystem]',
        '---',
        '',
        'Persona.'
      ].join('\n')
    );

    expect(svc.readAgentFile('agent-architect')).toMatchObject({
      name: 'Ada Reborn',
      role: 'Reviewer',
      modelProvider: 'OpenAI',
      modelName: 'codex',
      autonomyLevel: 'Supervised',
      temperature: 0.2,
      skills: ['sk-fs'],
      mcpServers: ['alpha-github', 'filesystem']
    });
  });

  it('accepts union values in any case, because these files are typed by hand', () => {
    writeFile('---\nrole: coder\nprovider: anthropic\n---\n\nPersona.');

    const overlay = svc.readAgentFile('agent-architect');
    expect(overlay?.role).toBe('Coder');
    expect(overlay?.modelProvider).toBe('Anthropic');
  });

  it('drops an unrecognised role rather than passing it through', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFile('---\nname: Ada\nrole: Wizard\n---\n\nPersona.');

    const overlay = svc.readAgentFile('agent-architect');
    expect(overlay?.role).toBeUndefined();
    expect(overlay?.name).toBe('Ada');
  });

  it('drops an out-of-range temperature', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFile('---\ntemperature: 9\n---\n\nPersona.');

    expect(svc.readAgentFile('agent-architect')?.temperature).toBeUndefined();
  });

  it('omits keys the file did not mention, so a spread does not blank columns', () => {
    writeFile('---\nmodel: claude-opus-5\n---\n\nPersona.');

    const overlay = svc.readAgentFile('agent-architect')!;
    expect(Object.keys(overlay).sort()).toEqual(['modelName', 'systemPrompt']);
  });

  it('reads a file with no frontmatter as a prompt-only override', () => {
    writeFile('Just the persona prose, no frontmatter at all.');

    expect(svc.readAgentFile('agent-architect')).toEqual({
      systemPrompt: 'Just the persona prose, no frontmatter at all.'
    });
  });

  it('returns null for a file that is entirely empty', () => {
    writeFile('');
    expect(svc.readAgentFile('agent-architect')).toBeNull();
  });

  it('keeps the editor guidance comment out of the prompt', () => {
    svc.syncAgentFile(agent(), 'replace');

    const prompt = svc.readAgentFile('agent-architect')!.systemPrompt!;
    expect(prompt).toContain('You are Ada');
    expect(prompt).not.toContain('<!--');
    expect(prompt).not.toContain('alpha.db');
  });

  it('treats a heading-only body as no override, so the db column still applies', () => {
    writeFile('---\nname: Ada\n---\n\n# Ada Lovelace\n\n<!-- guidance only -->\n');

    const overlay = svc.readAgentFile('agent-architect');
    expect(overlay?.systemPrompt).toBeUndefined();
    expect(overlay?.name).toBe('Ada');
  });

  it('writes no placeholder prose for an agent with no prompt', () => {
    svc.syncAgentFile(agent({ systemPrompt: '' }), 'replace');

    expect(svc.readAgentFile('agent-architect')?.systemPrompt).toBeUndefined();
    expect(readFile()).not.toContain('No system prompt');
  });

  it('accepts a single unquoted value where a list is expected', () => {
    writeFile('---\nskills: sk-fs\n---\n\nPersona.');
    expect(svc.readAgentFile('agent-architect')?.skills).toEqual(['sk-fs']);
  });

  it('round-trips a written file back to the same values', () => {
    const original = agent({ temperature: 0.3 });
    svc.syncAgentFile(original, 'replace');

    expect(svc.readAgentFile(original.id)).toMatchObject({
      name: original.name,
      role: original.role,
      modelProvider: original.modelProvider,
      modelName: original.modelName,
      autonomyLevel: original.autonomyLevel,
      temperature: 0.3,
      skills: original.skills,
      mcpServers: original.mcpServers
    });
  });
});

describe('path safety', () => {
  it.each(['../escape', 'nested/id', 'back\\slash', '..', '.', ''])(
    'rejects the unsafe id %j',
    id => {
      expect(() => svc.agentFilePath(id)).toThrow(/Invalid agent id/);
    }
  );

  it('keeps a legitimate hyphenated id', () => {
    expect(svc.agentFilePath('agent-architect')).toBe(path.join(tmp, 'agents', 'agent-architect.md'));
  });
});

describe('deleteAgentFile', () => {
  it('removes the file', () => {
    svc.syncAgentFile(agent(), 'replace');
    expect(svc.agentFileExists('agent-architect')).toBe(true);

    svc.deleteAgentFile('agent-architect');
    expect(svc.agentFileExists('agent-architect')).toBe(false);
  });

  it('is a no-op for a file that is already gone', () => {
    expect(svc.deleteAgentFile('agent-ghost')).toBe(true);
  });
});

describe('ensureAgentFiles', () => {
  it('creates files only for agents that have none', () => {
    writeFile('---\nname: Ada\n---\n\nExisting persona.', 'agent-architect');

    const created = svc.ensureAgentFiles([
      agent(),
      agent({ id: 'agent-tester', name: 'Orion Cross', role: 'QA Tester' })
    ]);

    expect(created).toBe(1);
    expect(parseFrontmatter(readFile('agent-architect')).body).toBe('Existing persona.');
    expect(svc.agentFileExists('agent-tester')).toBe(true);
  });

  it('skips an agent whose id is unsafe without failing the rest', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const created = svc.ensureAgentFiles([
      agent({ id: '../evil' }),
      agent({ id: 'agent-tester' })
    ]);

    expect(created).toBe(1);
    expect(svc.agentFileExists('agent-tester')).toBe(true);
  });
});

describe('raw read and write — the editor path', () => {
  it('returns null for a file that does not exist', () => {
    expect(svc.readAgentFileRaw('agent-nobody')).toBeNull();
  });

  it('returns the file exactly as written', () => {
    const raw = '---\nname: Ada\n---\n\nHand written.\n';
    writeFile(raw);
    expect(svc.readAgentFileRaw('agent-architect')).toBe(raw);
  });

  it('saves text verbatim, frontmatter included', () => {
    svc.writeAgentFileRaw('agent-architect', '---\nmodel: claude-opus-5\n---\n\nMy persona.');

    const overlay = svc.readAgentFile('agent-architect');
    expect(overlay?.modelName).toBe('claude-opus-5');
    expect(overlay?.systemPrompt).toBe('My persona.');
  });

  it('normalises to a single trailing newline', () => {
    svc.writeAgentFileRaw('agent-architect', 'No frontmatter.\n\n\n');
    expect(readFile()).toBe('No frontmatter.\n');
  });

  it('creates the agents directory when saving into a fresh store', () => {
    expect(() => svc.writeAgentFileRaw('agent-new', 'Persona.')).not.toThrow();
    expect(svc.agentFileExists('agent-new')).toBe(true);
  });

  it('refuses content past the size cap', () => {
    const tooBig = 'x'.repeat(svc.AGENT_FILE_MAX_BYTES + 1);
    expect(() => svc.writeAgentFileRaw('agent-architect', tooBig)).toThrow(/exceeds/);
  });

  it('accepts content exactly at the cap', () => {
    expect(() =>
      svc.writeAgentFileRaw('agent-architect', 'y'.repeat(svc.AGENT_FILE_MAX_BYTES))
    ).not.toThrow();
  });

  it('rejects an unsafe id before touching the filesystem', () => {
    expect(() => svc.writeAgentFileRaw('../escape', 'Persona.')).toThrow(/Invalid agent id/);
  });

  it('round-trips an edit made through the editor path', () => {
    svc.syncAgentFile(agent(), 'replace');
    const original = svc.readAgentFileRaw('agent-architect')!;

    svc.writeAgentFileRaw('agent-architect', original.replace('claude-sonnet-5', 'claude-opus-5'));

    expect(svc.readAgentFile('agent-architect')?.modelName).toBe('claude-opus-5');
  });
});

describe('parseAgentFileContent — warnings for the editor', () => {
  it('reports no warnings for a valid file', () => {
    const { warnings } = svc.parseAgentFileContent('---\nrole: Coder\n---\n\nPersona.');
    expect(warnings).toEqual([]);
  });

  it('names the unknown role and lists what was expected', () => {
    const { warnings, overlay } = svc.parseAgentFileContent('---\nrole: Wizard\n---\n\nPersona.');

    expect(overlay?.role).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Wizard');
    expect(warnings[0]).toContain('Architect');
  });

  it('warns about an unknown provider', () => {
    const { warnings } = svc.parseAgentFileContent('---\nprovider: Skynet\n---\n\nPersona.');
    expect(warnings[0]).toContain('Skynet');
  });

  it('warns about an out-of-range temperature', () => {
    const { warnings } = svc.parseAgentFileContent('---\ntemperature: 9\n---\n\nPersona.');
    expect(warnings[0]).toMatch(/temperature/i);
  });

  it('collects every problem rather than stopping at the first', () => {
    const { warnings } = svc.parseAgentFileContent(
      '---\nrole: Wizard\nprovider: Skynet\ntemperature: 9\n---\n\nPersona.'
    );
    expect(warnings).toHaveLength(3);
  });

  it('still returns the valid fields alongside the warnings', () => {
    const { overlay, warnings } = svc.parseAgentFileContent(
      '---\nrole: Wizard\nmodel: claude-opus-5\n---\n\nPersona.'
    );

    expect(warnings).toHaveLength(1);
    expect(overlay?.modelName).toBe('claude-opus-5');
    expect(overlay?.systemPrompt).toBe('Persona.');
  });

  it('reports nothing for empty content', () => {
    expect(svc.parseAgentFileContent('')).toEqual({ overlay: null, warnings: [] });
  });
});
