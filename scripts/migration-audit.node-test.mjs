import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditExitCode, compareMigrationBaseline, migrationFingerprint } from './audit-migrations.mjs';

const source = 'create table example (id text);';
const sha256 = migrationFingerprint(source);
const entry = {
  local_file: '0001_example.sql', local_sha256: sha256,
  remote_version: '20261007000001', remote_sql_md5: 'a'.repeat(32),
  review: 'exact_normalized_sql',
};
const snapshot = changes => ({ format_version: 1, migrations: [{ ...entry, ...changes }] });
const local = [{ name: entry.local_file, sha256 }];

test('normalizes line endings and outer whitespace, not SQL content', () => {
  assert.equal(migrationFingerprint('\r\n' + source + '\r\n'), sha256);
  assert.notEqual(migrationFingerprint(source.replace('text', 'uuid')), sha256);
});

test('matches unchanged reviewed source without claiming live readiness', () => {
  const report = compareMigrationBaseline(local, snapshot());
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.results[0].status, 'baseline_match');
  assert.equal(auditExitCode(report), 0);
  assert.equal('deploymentReady' in report, false);
});

test('rejects source changed since review even in baseline-only mode', () => {
  const report = compareMigrationBaseline([{ ...local[0], sha256: 'b'.repeat(64) }], snapshot());
  assert.equal(report.results[0].status, 'changed_since_review');
  assert.equal(auditExitCode(report, true), 1);
});

test('reports added and missing local migrations', () => {
  const report = compareMigrationBaseline([{ name: '0002_other.sql', sha256 }], snapshot());
  assert.deepEqual(report.results.map(row => row.status), ['unreviewed_local', 'missing_local']);
  assert.equal(auditExitCode(report), 1);
});

test('keeps unrecorded migrations visible and blocks the strict check', () => {
  const report = compareMigrationBaseline(local, snapshot({ remote_version: null, remote_sql_md5: null, review: 'not_recorded' }));
  assert.equal(report.results[0].status, 'not_recorded');
  assert.equal(auditExitCode(report), 2);
  assert.equal(auditExitCode(report, true), 0);
});

test('does not silently treat reviewed SQL differences as exact matches', () => {
  const report = compareMigrationBaseline(local, snapshot({ review: 'reviewed_difference' }));
  assert.equal(report.results[0].status, 'reviewed_difference');
  assert.equal(auditExitCode(report), 2);
});

test('rejects duplicate baseline entries and recorded versions', () => {
  assert.throws(() => compareMigrationBaseline(local, { format_version: 1, migrations: [entry, entry] }));
  assert.throws(() => compareMigrationBaseline(local, {
    format_version: 1, migrations: [entry, { ...entry, local_file: '0002_other.sql' }],
  }));
});

test('rejects unsafe file names and inconsistent pending metadata', () => {
  assert.throws(() => compareMigrationBaseline(local, snapshot({ local_file: '../secret.sql' })));
  assert.throws(() => compareMigrationBaseline(local, snapshot({ remote_version: null })));
  assert.throws(() => compareMigrationBaseline(local, snapshot({ review: 'unknown' })));
});
