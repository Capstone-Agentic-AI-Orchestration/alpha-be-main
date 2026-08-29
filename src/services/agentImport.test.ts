import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Importing an agent from a file someone else exported. This is the one
 * capability that behaves the same locally and hosted, because an agent
 * definition is data rather than execution — so it is worth being strict about
 * what does and does not travel.
 */
type Service = typeof import('./agentFileService.js');

let tmp: string;
let svc: Service;

const file = (frontmatter: string, body = 'You are the persona.') =>
  `---\n${frontmatter}\n---\n\n${body}`;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-import-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  svc = await import('./agentFileService.js');
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
});

describe('agentFromFileContent', () => {
  it('builds an agent from a complete file', () => {
    const { agent } = svc.agentFromFileContent(
      file(
        [
          'name: Ada Lovelace',
          'role: Architect',
          'provider: Anthropic',
          'model: claude-opus-5',
          'autonomy: Supervised',
          'skills: [sk-fs, sk-git]',
          'mcpServers: [alpha-github]',
          'color: "#6366f1"'
        ].join('\n')
      ),
      []
    );

    expect(agent).toMatchObject({
      name: 'Ada Lovelace',
      role: 'Architect',
      modelProvider: 'Anthropic',
      modelName: 'claude-opus-5',
      autonomyLevel: 'Supervised',
      skills: ['sk-fs', 'sk-git'],
      mcpServers: ['alpha-github'],
      color: '#6366f1'
    });
    expect(agent.systemPrompt).toContain('You are the persona.');
  });

  it('refuses a file with no name, since there is no agent to make', () => {
    expect(() => svc.agentFromFileContent(file('role: Coder'), [])).toThrow(/no `name:`/);
  });

  it('never imports environment variables', () => {
    // The file is the thing people send each other. Someone else's keys must
    // not ride along, and envVars is not a file field in the first place.
    const { agent } = svc.agentFromFileContent(
      file('name: Ada\nenvVars: [SECRET=hunter2]'),
      []
    );

    expect(agent.envVars).toEqual([]);
    expect(JSON.stringify(agent)).not.toContain('hunter2');
  });

  it('does not carry custom CLI arguments across machines', () => {
    const { agent } = svc.agentFromFileContent(file('name: Ada'), []);
    expect(agent.customCliArgs).toBe('');
  });

  it('leaves the model blank rather than guessing one this machine lacks', () => {
    const { agent } = svc.agentFromFileContent(file('name: Ada'), []);
    expect(agent.modelName).toBe('');
  });

  it('falls back and reports rather than refusing over one bad field', () => {
    const { agent, warnings } = svc.agentFromFileContent(
      file('name: Ada\nrole: Wizard'),
      []
    );

    expect(agent.role).toBe('Coder');
    expect(warnings.join(' ')).toMatch(/Wizard/);
  });

  it('warns when the file carries no persona text', () => {
    const { warnings } = svc.agentFromFileContent(file('name: Ada', ''), []);
    expect(warnings.join(' ')).toMatch(/no persona text/i);
  });

  it('mints a readable id from the name', () => {
    const { agent } = svc.agentFromFileContent(file('name: Ada Lovelace'), []);
    expect(agent.id).toBe('agent-ada-lovelace');
  });

  it('does not collide with an agent already on this machine', () => {
    const { agent } = svc.agentFromFileContent(file('name: Ada Lovelace'), [
      'agent-ada-lovelace'
    ]);
    expect(agent.id).toBe('agent-ada-lovelace-2');
  });

  it('never reuses the id from the file, so importing twice makes two agents', () => {
    const content = file('name: Ada Lovelace');
    const first = svc.agentFromFileContent(content, []).agent;
    const second = svc.agentFromFileContent(content, [first.id]).agent;

    expect(second.id).not.toBe(first.id);
  });
});

describe('uniqueAgentId', () => {
  it('slugifies punctuation and case', () => {
    expect(svc.uniqueAgentId('Ada  Lovelace!! (v2)', [])).toBe('agent-ada-lovelace-v2');
  });

  it('never produces a path segment that could escape the directory', () => {
    for (const name of ['../escape', 'a/b', 'a\b', '..']) {
      const id = svc.uniqueAgentId(name, []);
      expect(() => svc.agentFilePath(id)).not.toThrow();
      expect(id.includes('/')).toBe(false);
      expect(id.includes('\\')).toBe(false);
    }
  });

  it('falls back to a usable id when the name has no usable characters', () => {
    expect(svc.uniqueAgentId('!!!', [])).toBe('agent-agent');
  });

  it('keeps counting past the first collision', () => {
    expect(svc.uniqueAgentId('Ada', ['agent-ada', 'agent-ada-2'])).toBe('agent-ada-3');
  });
});

describe('export and import round trip', () => {
  it('does not duplicate the heading each cycle', () => {
    // The generated body opens with `# {name}`, which comes back as part of
    // systemPrompt — so writing the file again used to prepend a second copy,
    // and every further cycle another.
    const original = svc.agentFromFileContent(file('name: Ada Lovelace'), []).agent;
    svc.syncAgentFile(original, 'replace');

    const exported = svc.readAgentFileRaw(original.id)!;
    const reimported = svc.agentFromFileContent(exported, [original.id]).agent;
    svc.syncAgentFile(reimported, 'replace');

    const twice = svc.readAgentFileRaw(reimported.id)!;
    expect(twice.match(/# Ada Lovelace/g) ?? []).toHaveLength(1);
  });

  it('reaches a fixed point — further cycles change nothing but the id', () => {
    /**
     * The first write adds the `# {name}` heading to the body, so cycle one is
     * not identical to the source. What matters is that it settles: cycle two
     * and cycle three must be the same, or the file grows every time it is
     * passed between people.
     */
    const cycle = (content: string, taken: string[]) => {
      const { agent } = svc.agentFromFileContent(content, taken);
      svc.syncAgentFile(agent, 'replace');
      return { agent, exported: svc.readAgentFileRaw(agent.id)! };
    };

    const source = file('name: Ada Lovelace\nrole: Architect\nprovider: Anthropic\nmodel: claude-opus-5');
    const one = cycle(source, []);
    const two = cycle(one.exported, [one.agent.id]);
    const three = cycle(two.exported, [one.agent.id, two.agent.id]);

    // Identical apart from the frontmatter `name` staying the same and the id
    // differing, which the file does not carry.
    expect(three.agent.systemPrompt).toBe(two.agent.systemPrompt);
    expect(three.agent.role).toBe(two.agent.role);
    expect(three.agent.modelProvider).toBe(two.agent.modelProvider);
    expect(three.agent.modelName).toBe(two.agent.modelName);
    expect(three.agent.id).not.toBe(two.agent.id);
  });

  it('preserves the defining fields from the original source file', () => {
    const { agent } = svc.agentFromFileContent(
      file('name: Ada Lovelace\nrole: Architect\nprovider: Anthropic\nmodel: claude-opus-5'),
      []
    );
    svc.syncAgentFile(agent, 'replace');

    const second = svc.agentFromFileContent(svc.readAgentFileRaw(agent.id)!, [agent.id]).agent;

    expect(second.name).toBe('Ada Lovelace');
    expect(second.role).toBe('Architect');
    expect(second.modelProvider).toBe('Anthropic');
    expect(second.modelName).toBe('claude-opus-5');
    expect(second.systemPrompt).toContain('You are the persona.');
  });

  it('keeps the persona text through a cycle', () => {
    const agent = svc.agentFromFileContent(
      file('name: Ada', 'Lead with the interface, then the implementation.'),
      []
    ).agent;
    svc.syncAgentFile(agent, 'replace');

    const reimported = svc.agentFromFileContent(svc.readAgentFileRaw(agent.id)!, [agent.id]).agent;
    expect(reimported.systemPrompt).toContain('Lead with the interface');
  });
});
