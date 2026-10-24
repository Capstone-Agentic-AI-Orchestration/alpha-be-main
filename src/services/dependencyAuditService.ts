import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';
import { dependencyAuditEvidenceSchema, type DependencyAuditEvidence, type DependencyAuditSpec } from './dependencyAuditContract.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const active = new Map<AbortController, Promise<void>>();
const MAX_INPUT = 4 * 1024 * 1024;
type CommandResult = { code: number | null; stdout: string; stderr: string };
export type AuditCommand = (bin: string, args: string[], cwd: string, signal: AbortSignal) => Promise<CommandResult>;

/** Only dependency metadata is copied; project scripts/configuration are never executed. */
export function dependencyInputs(directory: string) {
  const read = (name: string): string => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_INPUT) throw new Error(`Unsafe or oversized ${name}.`);
    return fs.readFileSync(file, 'utf8');
  };
  const manifest = read('package.json');
  const lockName = ['npm-shrinkwrap.json', 'package-lock.json'].find(name => fs.existsSync(path.join(directory, name)));
  const lock = lockName ? read(lockName) : '';
  return { manifest, lock, lockName, inputHash: hash(manifest + '\0' + (lockName ?? '') + '\0' + lock) };
}

function assertRegistryDependencies(manifest: Record<string, any>): void {
  if (manifest.packageManager && !String(manifest.packageManager).startsWith('npm@')) throw new Error('Only npm dependency audits are supported.');
  if (manifest.workspaces) throw new Error('Workspace dependency trees need a separately authorized scanner; this audit is limited to one repository manifest.');
  const check = (value: unknown) => {
    if (typeof value === 'string' && !/^[\w.+*^~<>=| $-]+$/.test(value)) throw new Error('Non-registry dependency specifications need a separately authorized scanner.');
    if (value && typeof value === 'object') Object.values(value).forEach(check);
  };
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']) check(manifest[key]);
}

const runCommand: AuditCommand = (bin, args, cwd, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Dependency audit was cancelled.')); return; }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  Object.assign(childEnv, {
    npm_config_ignore_scripts: 'true', npm_config_cache: path.join(cwd, 'cache'),
    npm_config_userconfig: path.join(cwd, '.npmrc'), npm_config_globalconfig: path.join(cwd, 'global.npmrc'),
    npm_config_fetch_retries: '0', npm_config_fetch_timeout: '20000', npm_config_update_notifier: 'false'
  });
  const child = spawn(bin, args, { cwd, env: childEnv, windowsHide: true });
  let stdout = '', stderr = '', exceeded = false;
  const stop = () => { if (child.pid) treeKill(child.pid, 'SIGTERM', () => {}); };
  const timer = setTimeout(stop, 120_000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  child.stdout?.on('data', chunk => { if (exceeded) return; stdout += String(chunk); if (stdout.length > 1024 * 1024) { stdout = ''; exceeded = true; stop(); } });
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
  child.once('error', error => { finish(); reject(error); });
  child.once('close', code => { finish(); exceeded ? reject(new Error('Audit output exceeded 1 MiB.')) : resolve({ code, stdout, stderr }); });
});

export async function stopDependencyAudits(): Promise<void> {
  const running = [...active];
  for (const [controller] of running) controller.abort();
  await Promise.all(running.map(([, done]) => done));
}

function registryUrl(): string {
  const registry = new URL(process.env.ALPHA_AUDIT_REGISTRY || 'https://registry.npmjs.org/');
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) throw new Error('The audit registry must be an HTTPS URL without embedded credentials.');
  return registry.href;
}

/** Persisted by Alpha's MCP service, never by a model-provided file write. */
export async function runDependencyAudit(input: {
  directory: string; evidenceDirectory: string; taskId: string; repository: string; spec: DependencyAuditSpec;
}, command: AuditCommand = runCommand): Promise<DependencyAuditEvidence> {
  const inputs = dependencyInputs(input.directory);
  const manifest = JSON.parse(inputs.manifest);
  assertRegistryDependencies(manifest);
  if (!inputs.lockName && ['yarn.lock', 'pnpm-lock.yaml'].some(name => fs.existsSync(path.join(input.directory, name)))) throw new Error('Use the project package manager; npm cannot audit a Yarn/pnpm lockfile.');
  const registry = registryUrl();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-dependency-audit-'));
  const controller = new AbortController();
  let finished!: () => void;
  active.set(controller, new Promise<void>(resolve => { finished = resolve; }));
  const deadline = setTimeout(() => controller.abort(), 90_000);
  const record: DependencyAuditEvidence = {
    schemaVersion: 1, id: 'audit-' + randomUUID(), taskId: input.taskId, repository: input.repository,
    sourceCommit: '', inputHash: inputs.inputHash, resolvedLockHash: '', resolvedFromManifest: !inputs.lockName,
    createdAt: new Date().toISOString(), scanner: 'npm', scannerVersion: '', registry,
    purpose: input.spec.purpose, level: input.spec.level, status: 'error', passesPolicy: false, counts: {}, findings: []
  };
  try {
    const commit = await command('git', ['-C', input.directory, 'rev-parse', 'HEAD'], scratch, controller.signal);
    if (commit.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(commit.stdout.trim())) throw new Error('The audited source checkpoint is unavailable.');
    record.sourceCommit = commit.stdout.trim();
    const version = await command('npm', ['--version'], scratch, controller.signal);
    if (version.code !== 0) throw new Error('The npm audit scanner is unavailable.');
    record.scannerVersion = version.stdout.trim().slice(0, 80);
    // A lockfile cannot cause npm to fetch arbitrary git/file dependencies during preparation.
    if (inputs.lock) {
      const parsed = JSON.parse(inputs.lock);
      if (![2, 3].includes(parsed.lockfileVersion) || !parsed.packages?.['']) throw new Error('Audit requires an npm lockfile v2/v3 with a root package; regenerate older lockfiles through the implementation task.');
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const entries = (value: Record<string, unknown> = {}) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        if (entries(manifest[key]) !== entries(parsed.packages[''][key])) throw new Error('The dependency lockfile does not match package.json; reconcile it through the implementation task.');
      }
      for (const entry of Object.values(parsed.packages ?? {}) as any[]) {
        if (entry.link) throw new Error('Linked dependency trees need a separately authorized scanner.');
        if (entry.resolved) {
          const resolved = new URL(entry.resolved);
          if (resolved.origin !== new URL(registry).origin || resolved.username || resolved.password) throw new Error('This lockfile resolves outside the configured audit registry.');
        }
      }
      fs.writeFileSync(path.join(scratch, inputs.lockName!), inputs.lock);
    }
    delete manifest.scripts;
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(scratch, '.npmrc'), 'ignore-scripts=true\n');
    fs.writeFileSync(path.join(scratch, 'global.npmrc'), '');
    if (!inputs.lockName) {
      const prepare = await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + registry], scratch, controller.signal);
      if (prepare.code !== 0) throw new Error('Dependency resolution failed; check registry access, package versions and supported dependency sources.');
    }
    const resolvedLock = fs.readFileSync(path.join(scratch, inputs.lockName ?? 'package-lock.json'), 'utf8');
    record.resolvedLockHash = hash(resolvedLock);
    const result = await command('npm', ['audit', '--json', '--package-lock-only', '--ignore-scripts', '--audit-level=' + input.spec.level, '--registry=' + registry], scratch, controller.signal);
    if (controller.signal.aborted) throw new Error('Dependency audit was cancelled.');
    const report = JSON.parse(result.stdout);
    if (![0, 1].includes(result.code ?? -1) || report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) throw new Error('The scanner did not return an npm vulnerability report; check registry access/authentication.');
    const severityOrder = ['info', 'low', 'moderate', 'high', 'critical'];
    const counts = report.metadata.vulnerabilities;
    if ([...severityOrder, 'total'].some(level => !Number.isSafeInteger(counts[level]) || counts[level] < 0) ||
        counts.total !== severityOrder.reduce((sum, level) => sum + counts[level], 0) ||
        counts.total !== Object.keys(report.vulnerabilities).length || Object.values(report.vulnerabilities).some((item: any) => !severityOrder.includes(item.severity)) ||
        severityOrder.some(level => counts[level] !== Object.values(report.vulnerabilities).filter((item: any) => item.severity === level).length)) {
      throw new Error('The scanner returned inconsistent vulnerability counts.');
    }
    record.counts = Object.fromEntries([...severityOrder, 'total'].map(level => [level, counts[level]]));
    record.passesPolicy = severityOrder.slice(severityOrder.indexOf(input.spec.level)).every(level => (record.counts[level] ?? 0) === 0);
    record.status = (record.counts.total ?? Object.values(report.vulnerabilities).length) > 0 ? 'findings' : 'clean';
    if (Object.keys(report.vulnerabilities).length > 200) throw new Error('The audit contains more than 200 findings; split the dependency scope.');
    record.findings = Object.entries(report.vulnerabilities).map(([name, raw]) => {
      const item = raw as any;
      const fix = item.fixAvailable;
      return { package: name.slice(0, 200), severity: String(item.severity).slice(0, 40), range: String(item.range ?? '').slice(0, 400), direct: item.isDirect === true,
        nodes: (item.nodes ?? []).slice(0, 20).map((node: unknown) => String(node).slice(0, 400)),
        advisories: (item.via ?? []).slice(0, 20).map((via: any) => (typeof via === 'string' ? via : `${via.title ?? ''} ${via.url ?? ''}`).slice(0, 1000)),
        fixAvailable: fix && typeof fix === 'object' ? { name: String(fix.name), version: String(fix.version), isSemVerMajor: fix.isSemVerMajor === true } : fix === true };
    });
  } catch (error) {
    record.status = 'error'; record.passesPolicy = false;
    record.error = controller.signal.aborted ? 'Dependency audit was cancelled or exceeded its 90-second limit.' : error instanceof SyntaxError ? 'The scanner returned invalid JSON.' : error instanceof Error ? error.message.slice(0, 500) : 'Dependency audit could not run.';
  } finally {
    clearTimeout(deadline);
    active.delete(controller);
    try {
      if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('alpha-dependency-audit-')) fs.rmSync(scratch, { recursive: true, force: true });
    } finally { finished(); }
  }
  const checked = dependencyAuditEvidenceSchema.parse(record);
  fs.mkdirSync(input.evidenceDirectory, { recursive: true });
  const content = JSON.stringify(checked);
  fs.writeFileSync(path.join(input.evidenceDirectory, checked.id + '.json'), JSON.stringify({ content: checked, contentHash: hash(content) }), { flag: 'wx' });
  return checked;
}

export function readDependencyAuditEvidence(directory: string, ids: readonly string[]): DependencyAuditEvidence[] {
  return ids.map(id => {
    if (!/^audit-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid audit evidence identity.');
    const file = path.join(directory, id + '.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1024 * 1024) throw new Error('Invalid audit evidence file.');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const record = dependencyAuditEvidenceSchema.parse(envelope.content);
    if (record.id !== id || envelope.contentHash !== hash(JSON.stringify(record))) throw new Error('Audit evidence integrity check failed.');
    return record;
  });
}
