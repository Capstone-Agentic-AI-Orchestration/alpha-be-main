import { describe, expect, it } from 'vitest';
import { isSafeRelativePath, normalizeQuote, verifyCitations, type CheckpointReader } from './resolutionEvidence.js';

const files: Record<string, Record<string, string>> = {
  'acme/shop-be': {
    'src/routes/bookings.ts': 'router.get("/api/bookings", (req, res) => {\r\n  res.json({ id: booking.id, date: booking.date, guests: booking.guests });\r\n});'
  },
  'acme/shop-fe': { 'src/App.tsx': 'export const App = () => <Bookings />;' }
};

const reader: CheckpointReader = {
  async checkpoint(repository) {
    return files[repository.toLowerCase()] ? { repository: repository.toLowerCase(), dir: `/work/${repository}`, commit: 'c'.repeat(40) } : undefined;
  },
  async read(dir, _commit, filePath) {
    const content = files[dir.replace('/work/', '').toLowerCase()]?.[filePath];
    if (content === undefined) throw new Error('missing');
    return content;
  }
};

describe('resolution evidence', () => {
  it('verifies a quote in another repository of the build at its checkpoint, ignoring whitespace and line endings', async () => {
    const result = await verifyCitations([{ source: 'repository', repository: 'Acme/Shop-BE', path: 'src/routes/bookings.ts',
      quote: 'res.json({ id: booking.id,   date: booking.date,\n guests: booking.guests })' }], { reader });
    expect(result.refused).toEqual([]);
    expect(result.verified).toEqual([expect.objectContaining({ repository: 'acme/shop-be', path: 'src/routes/bookings.ts', commit: 'c'.repeat(40) })]);
  });

  it('refuses a fabricated quote, a missing file, a repository outside the build, a path escape and a trivial quote', async () => {
    const result = await verifyCitations([
      { source: 'repository', repository: 'acme/shop-be', path: 'src/routes/bookings.ts', quote: 'res.json({ id: booking.id, total: booking.total })' },
      { source: 'repository', repository: 'acme/shop-be', path: 'src/routes/missing.ts', quote: 'export const missing = true;' },
      { source: 'repository', repository: 'other/repo', path: 'src/a.ts', quote: 'export const a = 1;' },
      { source: 'repository', repository: 'acme/shop-be', path: '../secrets/.env', quote: 'API_KEY=1234567890' },
      { source: 'repository', repository: 'acme/shop-be', path: 'src/routes/bookings.ts', quote: '});' }
    ], { reader });
    expect(result.verified).toEqual([]);
    expect(result.refused.map(item => item.reason)).toEqual([
      expect.stringContaining('not in src/routes/bookings.ts'),
      expect.stringContaining('does not exist'),
      expect.stringContaining('not a repository in this build'),
      expect.stringContaining('not a repository-relative'),
      expect.stringContaining('shorter than')
    ]);
  });

  it('verifies a recorded product decision against the settled product picture only', async () => {
    const picture = 'Decisions recorded in build plans:\n- Project A: keep it informational, no booking form';
    const ok = await verifyCitations([{ source: 'product_picture', quote: 'keep it informational, no booking form' }], { reader, productPicture: picture });
    expect(ok.verified).toHaveLength(1);
    const invented = await verifyCitations([{ source: 'product_picture', quote: 'Project A takes bookings online' }], { reader, productPicture: picture });
    expect(invented.refused[0].reason).toMatch(/not in the project's recorded product picture/);
  });

  it('normalizes quotes and recognises safe paths', () => {
    expect(normalizeQuote('  a\r\n\tb  ')).toBe('a b');
    expect(isSafeRelativePath('src/a.ts')).toBe(true);
    for (const unsafe of ['/etc/passwd', 'C:/x', '../a', 'src/../../a', '', 'src//a']) expect(isSafeRelativePath(unsafe)).toBe(false);
  });
});
