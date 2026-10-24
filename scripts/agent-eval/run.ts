/**
 * Compare agent instructions on fixed tasks.
 *
 *   npx tsx scripts/agent-eval/run.ts [--model gpt-6-luna] [--cases id,id] [--versions v1,v2] [--parallel 3] [--out dir]
 *
 * Each case runs in a fresh git copy of ./fixture with the same task package
 * and the same model; only the persona differs. Alpha's own prompt builders
 * and report parser are used, so the comparison sees what a build sends and
 * accepts. Runs a real CLI: this costs model usage and takes minutes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

// Keep the evaluation away from the real Alpha data before any service loads.
const evalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-agent-eval-home-'));
process.env.ALPHA_HOME = evalHome;

const here = path.dirname(path.resolve(process.argv[1]));
const fixtureDir = path.join(here, 'fixture');
// Every task copy lives under one folder, which the evaluation's own database allows agents to work in.
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-agent-eval-work-'));

/**
 * v1: the first shipped wording. vN for an earlier numbered version: the last
 * wording kept for it. current: the template as it is now.
 */
type Version = string;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') { source += '.*'; index += 1; if (pattern[index + 1] === '/') index += 1; }
    else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^\${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

function npm(cwd: string, script: string): { ok: boolean; output: string } {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, '--silent'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: result.status === 0, output: ((result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : '')).slice(-1_500) };
}

async function main() {
  const { EVAL_CASES } = await import('./cases.js');
  const { OFFICIAL_AGENT_TEMPLATES, PREVIOUS_TEMPLATE_PROMPTS } = await import('../../src/services/officialAgentTemplates.js');
  const { appendOrchestrationTaskPolicy, formatOrchestrationTaskPackage, formatOrchestrationReportContract } = await import('../../src/services/runnerService.js');
  const { runCliTurn } = await import('../../src/services/cliRunner.js');
  const { parseAgentReport } = await import('../../src/services/orchestrationAgentReport.js');
  const { RuntimeService } = await import('../../src/services/runtimeService.js');
  const { sqliteService } = await import('../../src/services/sqliteService.js');
  sqliteService.addAllowedPath(workRoot, 'Agent evaluation');

  const model = argument('model', 'gpt-6-luna');
  const parallel = Math.max(1, Number(argument('parallel', '3')));
  const versions = argument('versions', 'v1,current').split(',') as Version[];
  const caseIds = argument('cases', '').split(',').filter(Boolean);
  const outDir = argument('out', path.join(os.tmpdir(), 'alpha-agent-eval'));
  fs.mkdirSync(outDir, { recursive: true });
  const approveForMe = typeof (RuntimeService as any).codexSupportsApproveForMe === 'function'
    ? await (RuntimeService as any).codexSupportsApproveForMe() : undefined;

  const cases = EVAL_CASES.filter(item => !caseIds.length || caseIds.includes(item.id));
  const jobs = cases.flatMap(item => versions.map(version => ({ item, version })));

  const runOne = async ({ item, version }: typeof jobs[number]) => {
    const template = OFFICIAL_AGENT_TEMPLATES.find(entry => entry.key === item.role)!;
    const earlier = PREVIOUS_TEMPLATE_PROMPTS[item.role];
    const persona = version === 'v1' ? earlier[0]
      : version === 'current' ? template.systemPrompt
      : /^v\d+$/.test(version) && Number(version.slice(1)) < template.version ? earlier[earlier.length - 1]
      : (() => { throw new Error('Unknown version ' + version); })();
    const cwd = fs.mkdtempSync(path.join(workRoot, item.id + '-' + version + '-'));
    fs.cpSync(fixtureDir, cwd, { recursive: true });
    for (const [file, content] of Object.entries(item.setupFiles ?? {})) {
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), content);
    }
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, '-c', 'user.name=eval', '-c', 'user.email=eval@alpha.local', 'add', '-A');
    git(cwd, '-c', 'user.name=eval', '-c', 'user.email=eval@alpha.local', 'commit', '-q', '-m', 'fixture');

    const reviewInputs = [];
    if (item.reviewPatch) {
      const startingCommit = git(cwd, 'rev-parse', 'HEAD');
      fs.mkdirSync(path.dirname(path.join(cwd, item.reviewPatch.path)), { recursive: true });
      fs.writeFileSync(path.join(cwd, item.reviewPatch.path), item.reviewPatch.after);
      git(cwd, '-c', 'user.name=eval', '-c', 'user.email=eval@alpha.local', 'add', '-A');
      git(cwd, '-c', 'user.name=eval', '-c', 'user.email=eval@alpha.local', 'commit', '-q', '-m', 'Add CSV amount parsing');
      const resultCommit = git(cwd, 'rev-parse', 'HEAD');
      const diff = git(cwd, 'diff', startingCommit, resultCommit);
      const diffHash = createHash('sha256').update(diff).digest('hex');
      reviewInputs.push({
        taskId: 'add-csv-import', title: 'Add CSV amount parsing', repository: 'eval/money-tracker', ownerAgentId: 'agent-backend',
        startingCommit, resultCommit, changedPaths: [item.reviewPatch.path], diff, diffHash, relatedFindings: [],
        sourceFiles: [{ path: item.reviewPatch.path, content: item.reviewPatch.after, contentHash: createHash('sha256').update(item.reviewPatch.after).digest('hex') }]
      });
    }
    const baseCommit = git(cwd, 'rev-parse', 'HEAD');

    const taskPackage = {
      packageVersion: 6 as const,
      reportSchemaVersion: 1,
      goal: item.title,
      projectContext: '',
      exclusions: [],
      task: {
        id: item.id, title: item.title, kind: item.kind, repository: 'eval/money-tracker', description: item.description,
        acceptanceCriteria: item.acceptanceCriteria, requiredChecks: item.requiredChecks,
        scope: { includePaths: item.includePaths, excludePaths: item.excludePaths ?? [] }
      },
      requirements: item.requirements,
      acceptedDependencies: item.handoff ? [{
        ...item.handoff, acceptedRevision: 1, requirementCoverage: [], verificationStatus: 'passed' as const,
        missingScripts: [], observedChecks: [{ script: 'test', result: 'passed' as const }],
        changedPaths: item.handoff.deliverables.flatMap(entry => entry.paths)
      }] : [],
      reviewInputs,
      corrections: [],
      findingIds: []
    };
    const systemPrompt = appendOrchestrationTaskPolicy(persona, { name: template.name, role: template.role }, { planVersion: 1, taskPackage } as any);
    const prompt = formatOrchestrationTaskPackage(taskPackage as any) + '\n\n' + formatOrchestrationReportContract(taskPackage as any);
    const codeTask = ['database', 'backend', 'frontend', 'mobile'].includes(item.kind);

    const started = Date.now();
    const result = await runCliTurn({
      runId: 'eval-' + randomUUID(), cwd: fs.mkdtempSync(path.join(workRoot, 'turn-')), mode: 'chat', approvalMode: 'ask',
      projectRoots: [{ name: 'fixture', repo: 'eval/money-tracker', dir: cwd }],
      mcpServers: ['alpha-task-files'],
      taskScope: { taskId: item.id, repository: 'eval/money-tracker', kind: item.kind, includePaths: item.includePaths, excludePaths: item.excludePaths ?? [], requiredChecks: item.requiredChecks, reportOnly: false },
      provider: 'OpenAI', modelName: model, systemPrompt, personaName: template.name, prompt, priorSession: null,
      skills: [], autonomyLevel: 'Supervised',

    } as any);
    const seconds = Math.round((Date.now() - started) / 1000);

    const parsed = parseAgentReport(result.content ?? '', 1);
    const report = parsed.report as any;
    // Not trimmed: the first porcelain line starts with a status column that may be a space.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
    const changedPaths = status.split('\n').filter(line => line.trim()).map(line => line.slice(3).trim().replace(/^"|"$/g, ''));
    const committed = git(cwd, 'diff', '--name-only', baseCommit, 'HEAD').split('\n').filter(Boolean);
    const allChanged = [...new Set([...changedPaths, ...committed])];
    const include = item.includePaths.map(globToRegExp);
    const exclude = (item.excludePaths ?? []).map(globToRegExp);
    const outOfScope = allChanged.filter(file => !include.some(re => re.test(file)) || exclude.some(re => re.test(file)));
    const checkRuns = item.requiredChecks.map(script => ({ script, ...npm(cwd, script) }));
    const checksPass = checkRuns.every(check => check.ok);
    const failedChecks = checkRuns.filter(check => !check.ok).map(check => ({ script: check.script, output: check.output }));
    let hiddenPass: boolean | undefined;
    if (item.hiddenTest) {
      fs.writeFileSync(path.join(cwd, 'tests', '__hidden.test.js'), item.hiddenTest);
      hiddenPass = spawnSync(process.execPath, ['--test', 'tests/__hidden.test.js'], { cwd, encoding: 'utf8' }).status === 0;
    }
    const blockers: string[] = report?.blockers ?? [];
    const findings: any[] = report?.reviewFindings ?? [];
    // Evidence that the criterion fails, not merely that something stopped the agent.
    const reportText = JSON.stringify([report?.summary, report?.criteriaEvidence, report?.requirementCoverage]);
    const reportedFailure = Boolean(report && (
      (report.reportedChecks ?? []).some((check: any) => check.result === 'failed') ||
      (item.failureEvidence ? new RegExp(item.failureEvidence, 'i').test(reportText) : /\bfail/i.test(reportText))
    ));

    // Alpha rejects any report with a blocker, so only the blocker case may have one.
    const unexpectedBlocker = item.expect !== 'blocker' && blockers.length > 0;
    let pass = false;
    if (item.expect === 'change') pass = Boolean(report) && Boolean(hiddenPass) && checksPass && outOfScope.length === 0 && allChanged.length > 0 && !unexpectedBlocker;
    if (item.expect === 'blocker') pass = Boolean(report) && blockers.length > 0 && allChanged.length === 0;
    if (item.expect === 'finding') pass = Boolean(report) && allChanged.length === 0 && findings.some(finding =>
      ['blocking', 'critical'].includes(finding.severity) && (finding.path ?? '').replace(/\\/g, '/').endsWith(item.findingPath ?? ''));
    if (item.expect === 'no_blocking_finding') pass = Boolean(report) && allChanged.length === 0 && !unexpectedBlocker &&
      !findings.some(finding => ['blocking', 'critical'].includes(finding.severity));
    if (item.expect === 'validation_fail') pass = Boolean(report) && allChanged.length === 0 && reportedFailure && !unexpectedBlocker;
    if (item.expect === 'finding') pass = pass && !unexpectedBlocker;

    // Damage an editor would never cause: replacement characters, or exports the fixture had that are now gone.
    const damage: string[] = [];
    for (const file of allChanged) {
      const after = path.join(cwd, file);
      const before = path.join(fixtureDir, file);
      if (!fs.existsSync(after)) continue;
      const text = fs.readFileSync(after, 'utf8');
      if (text.includes('\uFFFD')) damage.push(file + ': corrupted characters');
      if (fs.existsSync(before)) {
        const exported = [...fs.readFileSync(before, 'utf8').matchAll(/export function (\w+)/g)].map(match => match[1]);
        const lost = exported.filter(name => !new RegExp('export function ' + name + '\\b').test(text));
        if (lost.length) damage.push(file + ': removed ' + lost.join(', '));
      }
    }

    const record = {
      case: item.id, version, model, pass, seconds, unexpectedBlocker,
      reportValid: Boolean(report), reportError: parsed.error,
      blockers, blockerTooLong: blockers.some(text => text.length > 240),
      changed: allChanged, outOfScope, checksPass, failedChecks, hiddenPass, damage,
      findings: findings.map(finding => ({ severity: finding.severity, path: finding.path, title: finding.title })),
      failure: result.failureDetail
    };
    const files = Object.fromEntries(allChanged.filter(file => fs.existsSync(path.join(cwd, file)))
      .map(file => [file, fs.readFileSync(path.join(cwd, file), 'utf8').slice(0, 6_000)]));
    fs.writeFileSync(path.join(outDir, item.id + '-' + version + '.json'), JSON.stringify({ ...record, response: result.content, files }, null, 2));
    console.log((pass ? 'PASS' : 'FAIL') + ' ' + item.id + ' ' + version + ' (' + seconds + 's)' + (record.reportValid ? '' : ' report: ' + record.reportError));
    return record;
  };

  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { results.push(await runOne(job)); }
      catch (error) { console.log('ERROR ' + job.item.id + ' ' + job.version + ': ' + (error instanceof Error ? error.message : String(error))); }
    }
  }));

  const rows = cases.map(item => '| ' + item.id + ' | ' + item.expect + ' | ' + versions.map(version => {
    const record = results.find(entry => entry.case === item.id && entry.version === version);
    if (!record) return 'error';
    const notes = [!record.reportValid && 'invalid report', record.outOfScope.length && 'out of scope: ' + record.outOfScope.join(', '),
      record.hiddenPass === false && 'hidden test failed', !record.checksPass && item.expect === 'change' && 'checks failed',
      record.blockerTooLong && 'blocker over 240 chars', record.unexpectedBlocker && 'reported a blocker',
      record.damage.length && 'damaged ' + record.damage.join(', ')].filter(Boolean).join('; ');
    return (record.pass ? 'pass' : 'fail') + (notes ? ' (' + notes + ')' : '') + ' · ' + record.seconds + 's';
  }).join(' | ') + ' |');
  const score = (version: Version) => results.filter(entry => entry.version === version && entry.pass).length + '/' + cases.length;
  const summary = ['# Agent instruction evaluation', '', 'Model: ' + model + ' · ' + new Date().toISOString(), '',
    '| Case | Expected | ' + versions.join(' | ') + ' |', '|---|---|' + versions.map(() => '---|').join(''), ...rows, '',
    'Score: ' + versions.map(version => version + ' ' + score(version)).join(' · ')].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), summary + '\n');
  console.log('\n' + summary + '\n\nDetails: ' + outDir);
  try { sqliteService.close(); } catch { /* already closed */ }
  for (const dir of [evalHome, workRoot]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a file; the OS temp folder clears it later */ }
  }
  return results.length === jobs.length && results.every(record => record.pass);
}

main().then(passed => process.exit(passed ? 0 : 1), error => { console.error(error); process.exit(1); });

