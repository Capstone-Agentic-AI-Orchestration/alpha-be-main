// A minimal lint: no console.log and no eval in src.
import fs from 'node:fs';
import path from 'node:path';
const problems = [];
for (const file of fs.readdirSync('src')) {
  const text = fs.readFileSync(path.join('src', file), 'utf8');
  if (/console\.log\(/.test(text)) problems.push(file + ': console.log');
  if (/\beval\(/.test(text)) problems.push(file + ': eval');
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('lint passed');
