#!/usr/bin/env node
/**
 * Code-quality check for the lines a change adds or edits.
 *
 *   npm run quality                    # against origin/main
 *   npm run quality -- --base <ref>    # against another branch or commit
 *
 * Lints the changed source files with eslint.config.mjs, then keeps only findings on
 * added or edited lines, so existing code never blocks a change that merely touches its
 * file. Errors fail the run; warnings are listed. In GitHub Actions each finding is also
 * written as an annotation on the pull request diff.
 *
 * Only the reported line counts: a complexity finding sits on the function's name, so a
 * new or renamed complex function is caught, while edits inside an old one are not.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const argBase = process.argv.indexOf('--base');
const base = argBase > -1 ? process.argv[argBase + 1] : (process.env.QUALITY_BASE || 'origin/main');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

let mergeBase;
try {
  mergeBase = git('merge-base', base, 'HEAD');
} catch {
  console.error(`Cannot find "${base}". Fetch it first (CI checks out with fetch-depth: 0) or pass --base <ref>.`);
  process.exit(2);
}

/** Added or edited line numbers per file, from a zero-context diff. */
const changed = new Map();
let current;
for (const line of git('diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=AM', mergeBase, '--').split('\n')) {
  if (line.startsWith('+++ ')) {
    const file = line.slice(4).replace(/^b\//, '');
    current = file !== '/dev/null' && SOURCE.test(file) ? file : undefined;
    if (current) changed.set(current, new Set());
  } else if (current && line.startsWith('@@')) {
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset++) changed.get(current).add(start + offset);
  }
}

// Locally, a new file may not be committed yet: every line of it is new.
for (const file of git('ls-files', '--others', '--exclude-standard').split('\n')) {
  if (!SOURCE.test(file)) continue;
  const count = readFileSync(file, 'utf8').split('\n').length;
  changed.set(file, new Set(Array.from({ length: count }, (_, index) => index + 1)));
}

const eslint = new ESLint();
const files = [];
for (const [file, lines] of changed) if (lines.size && !(await eslint.isPathIgnored(file))) files.push(file);
if (!files.length) {
  console.log(`Code quality: no changed source lines since ${base}.`);
  process.exit(0);
}

const findings = [];
for (const result of await eslint.lintFiles(files)) {
  const file = path.relative(process.cwd(), result.filePath).split(path.sep).join('/');
  for (const message of result.messages) {
    if (message.fatal) findings.push({ file, line: message.line ?? 1, severity: 2, rule: 'parse-error', text: message.message });
    else if (changed.get(file)?.has(message.line)) findings.push({ file, line: message.line, severity: message.severity, rule: message.ruleId, text: message.message });
  }
}

const errors = findings.filter(item => item.severity === 2);
const inActions = process.env.GITHUB_ACTIONS === 'true';
for (const item of findings.sort((a, b) => b.severity - a.severity || a.file.localeCompare(b.file) || a.line - b.line)) {
  const level = item.severity === 2 ? 'error' : 'warning';
  console.log(`${level.padEnd(7)} ${item.file}:${item.line}  ${item.text}  (${item.rule})`);
  if (inActions) console.log(`::${level} file=${item.file},line=${item.line},title=${item.rule}::${item.text.replace(/\r?\n/g, ' ')}`);
}
console.log(`\nCode quality: ${files.length} changed file(s) checked against ${base}; ${errors.length} error(s), ${findings.length - errors.length} warning(s) on changed lines.`);
process.exit(errors.length ? 1 : 0);
