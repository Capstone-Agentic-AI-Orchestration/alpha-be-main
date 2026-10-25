import path from 'node:path';

/**
 * Order a reviewer's extra source files by how the code is connected to what changed.
 *
 * The reviewer always gets the changed and reported files first. The remaining slots
 * used to go to files whose names shared words with the task title, so a task called
 * "fix checkout totals" pulled in checkout.css before the pricing module the patch
 * imported. These files are ranked from the code instead:
 *   3 - a changed file imports it (a relative import that resolves to the file),
 *   2 - it is the test for a changed source file, or the source a changed test covers,
 *   1 - it sits in the same folder as a changed file.
 * Ties keep a stable alphabetical order.
 */

export interface RankingAnchor {
  path: string;
  content: string;
}

// Relative specifiers only; packages are not repository files.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire|@import)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.css', '.scss'];
// TypeScript ESM imports name the emitted .js file; the source is the .ts beside it.
const EMITTED_TO_SOURCE: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts']
};
const TEST_SUFFIX = /\.(?:test|spec)$/;

export function relativeImports(content: string): string[] {
  return [...content.matchAll(RELATIVE_IMPORT)].map(match => match[1]);
}

/** The tracked file a relative import points at, if it is one of the candidates. */
export function resolveRelativeImport(fromPath: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier.split(/[?#]/)[0]));
  if (base.startsWith('../') || base === '..') return undefined;
  const extension = path.posix.extname(base);
  const options = [
    base,
    ...(EMITTED_TO_SOURCE[extension] ?? []).map(source => base.slice(0, -extension.length) + source),
    ...RESOLVE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVE_EXTENSIONS.map(ext => `${base}/index${ext}`)
  ];
  return options.find(option => files.has(option));
}

function stem(filePath: string): { dir: string; name: string; isTest: boolean } {
  const parsed = path.posix.parse(filePath);
  const isTest = TEST_SUFFIX.test(parsed.name) || parsed.dir.split('/').includes('__tests__');
  const dir = parsed.dir.split('/').filter(segment => segment !== '__tests__').join('/');
  return { dir, name: parsed.name.replace(TEST_SUFFIX, ''), isTest };
}

export function rankRelatedFiles(candidates: readonly string[], anchors: readonly RankingAnchor[]): string[] {
  const files = new Set(candidates);
  const imported = new Set(anchors.flatMap(anchor => relativeImports(anchor.content)
    .map(specifier => resolveRelativeImport(anchor.path, specifier, files))
    .filter((file): file is string => Boolean(file))));
  const anchorStems = anchors.map(anchor => stem(anchor.path));
  const anchorDirs = new Set(anchors.map(anchor => path.posix.dirname(anchor.path)));

  const score = (filePath: string): number => {
    if (imported.has(filePath)) return 3;
    const own = stem(filePath);
    if (anchorStems.some(other => other.name === own.name && other.dir === own.dir && other.isTest !== own.isTest)) return 2;
    return anchorDirs.has(path.posix.dirname(filePath)) ? 1 : 0;
  };
  return [...candidates].sort((left, right) => score(right) - score(left) || left.localeCompare(right));
}
