import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The database and the persona file both describe an agent, and `updateAgent`
 * writes to both. These tests cover the direction that was silently wrong:
 * editing anything in the UI used to rewrite EVERY frontmatter key from the
 * database row, so a hand-edited `model:` was destroyed by an unrelated rename.
 *
 * Unlike the other service tests these load sqliteService, which opens a real
 * database — hence the temp ALPHA_HOME and the dynamic import.
 */

let tmp: string;
let sqlite: typeof import('./sqliteService.js')['sqliteService'];
let files: typeof import('./agentFileService.js');

const AGENT = 'agent-architect';

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-wt-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  sqlite = (await import('./sqliteService.js')).sqliteService;
  files = await import('./agentFileService.js');
  files.ensureAgentFiles(sqlite.getAgents());
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  // Windows keeps the sqlite file handle briefly; a failed cleanup of a temp
  // directory must not fail the run.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
});

const handEdit = (model: string, body = 'Hand written persona.') =>
  fs.writeFileSync(
    path.join(tmp, 'agents', `${AGENT}.md`),
    ['---', 'name: Ada Lovelace', `model: ${model}`, '---', '', body].join('\n'),
    'utf8'
  );

describe('a UI edit must not destroy the persona file', () => {
  it('keeps a hand-edited model when an unrelated field changes', () => {
    handEdit('claude-opus-5');
    expect(sqlite.getAgents().find(a => a.id === AGENT)!.modelName).not.toBe('claude-opus-5');

    sqlite.updateAgent(AGENT, { description: 'Edited from the UI.' });

    expect(files.readAgentFile(AGENT)?.modelName).toBe('claude-opus-5');
  });

  it('keeps the hand-written body when an unrelated field changes', () => {
    handEdit('claude-opus-5');

    sqlite.updateAgent(AGENT, { description: 'Edited from the UI.' });

    expect(files.readAgentFile(AGENT)?.systemPrompt).toBe('Hand written persona.');
  });

  it('applies the unrelated change itself', () => {
    handEdit('claude-opus-5');

    sqlite.updateAgent(AGENT, { description: 'Edited from the UI.' });

    expect(files.readAgentFile(AGENT)?.description).toBe('Edited from the UI.');
  });
});

describe('a UI edit writes through to the file', () => {
  it('changes a file-declared field when it is edited explicitly', () => {
    handEdit('claude-opus-5');

    sqlite.updateAgent(AGENT, { modelName: 'claude-haiku-4-5' });

    expect(files.readAgentFile(AGENT)?.modelName).toBe('claude-haiku-4-5');
  });

  it('still preserves the body when writing a scalar through', () => {
    handEdit('claude-opus-5');

    sqlite.updateAgent(AGENT, { modelName: 'claude-haiku-4-5' });

    expect(files.readAgentFile(AGENT)?.systemPrompt).toBe('Hand written persona.');
  });

  it('replaces the body only when the system prompt is what changed', () => {
    handEdit('claude-opus-5');

    sqlite.updateAgent(AGENT, { systemPrompt: 'A brand new persona.' });

    expect(files.readAgentFile(AGENT)?.systemPrompt).toContain('A brand new persona.');
  });

  it('returns the merged agent, with the file winning over the row', () => {
    handEdit('claude-opus-5');

    const updated = sqlite.updateAgent(AGENT, { description: 'x' })!;

    expect(updated.modelName).toBe('claude-opus-5');
  });
});

describe('when there is no persona file', () => {
  it('falls back to the database row', () => {
    files.deleteAgentFile(AGENT);
    const before = sqlite.getAgents().find(a => a.id === AGENT)!.modelName;

    const updated = sqlite.updateAgent(AGENT, { description: 'x' })!;

    expect(updated.modelName).toBe(before);
  });

  it('recreates the file from the row', () => {
    files.deleteAgentFile(AGENT);

    sqlite.updateAgent(AGENT, { description: 'x' });

    expect(files.agentFileExists(AGENT)).toBe(true);
  });
});
