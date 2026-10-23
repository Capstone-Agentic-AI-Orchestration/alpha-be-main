import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  gitArgs,
  isSecretFile,
  listFiles,
  parseRoots,
  readFile,
  resolveInProject,
  searchFiles,
  type ProjectRoot
} from './projectFiles.js';

let base: string;
let roots: ProjectRoot[];
let other: string;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-project-files-')));
  const be = path.join(base, 'TestProject', 'app-be');
  const fe = path.join(base, 'TestProject', 'app-fe');
  other = path.join(base, 'OtherProject', 'other-fe');
  write(path.join(be, 'package.json'), '{\n  "name": "app-be"\n}\n');
  write(path.join(be, 'src', 'server.ts'), 'export const port = 3000;\nexport const secretWord = "hello";\n');
  write(path.join(be, '.env'), 'API_KEY=do-not-show\n');
  write(path.join(be, '.env.example'), 'API_KEY=\n');
  write(path.join(be, 'node_modules', 'dep', 'index.js'), 'export const port = 1;\n');
  write(path.join(fe, 'src', 'App.tsx'), 'export const App = () => null; // port\n');
  write(path.join(other, 'package.json'), '{ "name": "other-fe" }\n');
  roots = parseRoots(JSON.stringify([
    { name: 'app-be', repo: 'acme/app-be', dir: be },
    { name: 'app-fe', repo: 'acme/app-fe', dir: fe },
    { name: 'gone', repo: 'acme/gone', dir: path.join(base, 'missing') }
  ]));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('reading a project through alpha-project-files', () => {
  it('keeps the project repositories that exist and reads inside them', () => {
    expect(roots.map(root => root.name)).toEqual(['app-be', 'app-fe']);
    expect(readFile(roots, { repository: 'app-be', path: 'package.json' })).toContain('"name": "app-be"');
    expect(readFile(roots, { repository: 'acme/app-fe', path: 'src/App.tsx' })).toContain('export const App');
    const listing = listFiles(roots, { repository: 'app-be' });
    expect(listing).toContain('src/server.ts');
    expect(listing).toContain('node_modules/  (not listed)');
    expect(listing).not.toContain('dep/index.js');
  });

  it('refuses another project, by relative path and by absolute path', () => {
    expect(() => readFile(roots, { repository: 'app-be', path: '../../OtherProject/other-fe/package.json' })).toThrow('outside this project');
    expect(() => readFile(roots, { path: path.join(other, 'package.json') })).toThrow('outside this project');
    expect(() => listFiles(roots, { path: base })).toThrow('outside this project');
  });

  it('refuses a link inside the repository that points outside it', () => {
    const link = path.join(roots[0].dir, 'escape');
    fs.symlinkSync(path.join(base, 'OtherProject'), link, 'junction');
    expect(() => readFile(roots, { repository: 'app-be', path: 'escape/other-fe/package.json' })).toThrow('outside this project');
  });

  it('accepts an absolute path inside the project and asks which repository when it cannot tell', () => {
    expect(readFile(roots, { path: path.join(roots[1].dir, 'src', 'App.tsx') })).toContain('App');
    expect(() => listFiles(roots, {})).toThrow('Name the repository');
    expect(() => listFiles(roots, { repository: 'somebody-else' })).toThrow('is not one of');
  });

  it('lists secret files by name but never shows them, and still shows examples', () => {
    expect(listFiles(roots, { repository: 'app-be' })).toContain('.env  (secret: contents hidden)');
    expect(() => readFile(roots, { repository: 'app-be', path: '.env' })).toThrow('holds secrets');
    expect(readFile(roots, { repository: 'app-be', path: '.env.example' })).toContain('API_KEY=');
    expect(isSecretFile('id_rsa')).toBe(true);
    expect(isSecretFile('server.pem')).toBe(true);
    expect(isSecretFile('.env.local')).toBe(true);
    expect(isSecretFile('env.ts')).toBe(false);
  });

  it('searches every repository, skipping dependencies and secrets', () => {
    const found = searchFiles(roots, { query: 'port' });
    expect(found).toContain('app-be/src/server.ts:1: export const port = 3000;');
    expect(found).toContain('app-fe/src/App.tsx:1:');
    expect(found).not.toContain('node_modules');
    expect(searchFiles(roots, { query: 'do-not-show' })).toBe('No matches for "do-not-show".');
    expect(() => searchFiles(roots, { query: '(', regex: true })).toThrow('Invalid regular expression');
  });

  it('pages long files by line', () => {
    write(path.join(roots[0].dir, 'long.txt'), Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n'));
    const page = readFile(roots, { repository: 'app-be', path: 'long.txt', start_line: 11, max_lines: 5 });
    expect(page).toContain('(lines 11-15 of 30)');
    expect(page).toContain('11  line 11');
    expect(page).toContain('continue with start_line 16');
  });

  it('resolves relative paths with forward slashes', () => {
    expect(resolveInProject(roots, 'app-be', 'src\\server.ts').rel).toBe('src/server.ts');
  });
});

describe('git through alpha-project-files', () => {
  it('turns off what could run a program from the repository', () => {
    const diff = gitArgs('diff', { rel: 'src' });
    expect(diff).toEqual(expect.arrayContaining(['core.fsmonitor=false', '--no-ext-diff', '--no-textconv', ':(exclude,glob)**/.env']));
    expect(gitArgs('status')).toContain('core.fsmonitor=false');
  });

  it('refuses a ref that would be read as an option', () => {
    expect(() => gitArgs('log', { ref: '--output=C:/x' })).toThrow('is not a branch');
    expect(() => gitArgs('diff', { ref: 'main;rm' })).toThrow('is not a branch');
    expect(gitArgs('diff', { ref: 'main...HEAD' })).toContain('main...HEAD');
  });
});

