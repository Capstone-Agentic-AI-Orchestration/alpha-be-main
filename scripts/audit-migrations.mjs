import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same source normalization used by the read-only database inspection. */
export function migrationFingerprint(sql) {
  return createHash('sha256')
    .update(sql.replaceAll('\r\n', '\n').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''))
    .digest('hex');
}

/**
 * Compare local source with a reviewed historical snapshot. No network, SQL,
 * environment loader, credentials, or migration-application capability.
 * Fingerprints detect changed source, not semantic schema equivalence.
 */
export function compareMigrationBaseline(localFiles, snapshot) {
  if (snapshot?.format_version !== 1 || !Array.isArray(snapshot.migrations)) {
    throw new Error('Unsupported migration baseline format.');
  }
  const reviews = new Set([
    'exact_normalized_sql', 'formatting_reviewed', 'reviewed_difference', 'not_recorded',
  ]);
  const expected = new Map();
  const remoteVersions = new Set();
  for (const entry of snapshot.migrations) {
    if (!/^\d+_[A-Za-z0-9_]+\.sql$/.test(entry.local_file ?? '')
      || !/^[a-f0-9]{64}$/.test(entry.local_sha256 ?? '')
      || !reviews.has(entry.review)
      || expected.has(entry.local_file)) {
      throw new Error('Invalid or duplicate migration baseline entry.');
    }
    if (entry.remote_version !== null) {
      if (!/^\d{14}$/.test(entry.remote_version ?? '')
        || !/^[a-f0-9]{32}$/.test(entry.remote_sql_md5 ?? '')
        || remoteVersions.has(entry.remote_version)
        || entry.review === 'not_recorded') {
        throw new Error('Invalid or duplicate recorded migration version.');
      }
      remoteVersions.add(entry.remote_version);
    } else if (entry.review !== 'not_recorded' || entry.remote_sql_md5 !== null) {
      throw new Error('Unrecorded migration must have an explicit pending review.');
    }
    expected.set(entry.local_file, entry);
  }

  const seen = new Set();
  const results = [];
  for (const file of localFiles) {
    if (!/^\d+_[A-Za-z0-9_]+\.sql$/.test(file.name ?? '') || seen.has(file.name)
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
      throw new Error('Invalid or duplicate local migration entry.');
    }
    seen.add(file.name);
    const entry = expected.get(file.name);
    const status = !entry ? 'unreviewed_local'
      : entry.local_sha256 !== file.sha256 ? 'changed_since_review'
      : entry.review === 'not_recorded' ? 'not_recorded'
      : entry.review === 'reviewed_difference' ? 'reviewed_difference'
      : 'baseline_match';
    results.push({ file: file.name, remoteVersion: entry?.remote_version ?? null, status });
  }
  for (const [name, entry] of expected) {
    if (!seen.has(name)) results.push({ file: name, remoteVersion: entry.remote_version, status: 'missing_local' });
  }
  const sourceUnchanged = results.every(row => ['baseline_match', 'not_recorded', 'reviewed_difference'].includes(row.status));
  const hasKnownGaps = results.some(row => ['not_recorded', 'reviewed_difference'].includes(row.status));
  return { sourceUnchanged, hasKnownGaps, results };
}

export function auditExitCode(report, baselineOnly = false) {
  if (!report.sourceUnchanged) return 1;
  return report.hasKnownGaps && !baselineOnly ? 2 : 0;
}

export function runAudit(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/audit-migrations.mjs [--baseline-only]');
    console.log('Read-only local comparison. Exit 1: source drift; exit 2: known shared-database gaps.');
    console.log('--baseline-only permits documented gaps; it does not establish deployment readiness.');
    return 0;
  }
  if (args.some(arg => arg !== '--baseline-only')) throw new Error('Unsupported migration audit option.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'docs/client-ticketing/live-migration-baseline.json'), 'utf8'));
  const folder = path.join(root, 'supabase/migrations');
  const localFiles = fs.readdirSync(folder).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ name, sha256: migrationFingerprint(fs.readFileSync(path.join(folder, name), 'utf8')) }));
  const report = compareMigrationBaseline(localFiles, snapshot);
  console.log(`Historical baseline: ${snapshot.captured_on}; environment: ${snapshot.environment}.`);
  for (const row of report.results) console.log(`${row.file}: ${row.status}${row.remoteVersion ? ` (${row.remoteVersion})` : ''}`);
  console.log('This tool does not inspect the current live schema or authorize a deployment.');
  return auditExitCode(report, args.includes('--baseline-only'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runAudit();
  } catch {
    console.error('Migration audit failed. Check the baseline format and migration files; no database was contacted.');
    process.exitCode = 1;
  }
}
