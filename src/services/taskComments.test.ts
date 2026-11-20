import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPersonComment, isPersonComment } from './taskComments.js';

// Tests run from the package root.
const SRC = path.resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('task comments are for people', () => {
  it('accepts a person and refuses an agent or Alpha', () => {
    expect(isPersonComment({ authorType: 'user' })).toBe(true);
    expect(isPersonComment({ authorType: 'agent' })).toBe(false);
    expect(isPersonComment({ authorType: 'system' })).toBe(false);
    expect(() => assertPersonComment({ id: 'c1', authorType: 'user' })).not.toThrow();
    expect(() => assertPersonComment({ id: 'c2', authorType: 'agent' })).toThrow(/written by people only/);
    expect(() => assertPersonComment({ id: 'c3', authorType: 'system' })).toThrow(/written by people only/);
  });

  /**
   * The stores refuse these at run time; this catches a new writer before it
   * ships, since a refused comment would otherwise surface as a failed run.
   */
  it('has no source code that composes an agent or Alpha comment', () => {
    const offenders = sourceFiles(SRC)
      .filter(file => /authorType:\s*(?:'agent'|'system'|"agent"|"system")/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
