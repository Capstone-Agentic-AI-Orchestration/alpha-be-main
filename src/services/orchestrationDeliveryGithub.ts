import { githubApi, GitHubApiError, type GitHubApi } from './githubApi.js';
import { checksState, DeliveryError, type DeliveryCheck } from './orchestrationDelivery.js';

export interface DeliveryPull {
  number: number; html_url: string; state: string; merged: boolean; mergeable: boolean | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { sha: string; ref: string; repo: { full_name: string } };
}
interface RequiredCheck { context: string; app_id?: number | null }
interface CheckRun { id: number; name: string; status: string; conclusion: string | null; html_url?: string; app?: { id: number } }
interface Status { context: string; state: string; target_url?: string }

export class DeliveryGithub {
  constructor(private readonly api: GitHubApi = githubApi()) {}
  pull(repo: string, number: number) { return this.api.get<DeliveryPull>(`/repos/${repo}/pulls/${number}`); }
  async branch(repo: string, branch: 'dev' | 'uat') {
    return (await this.api.get<{ commit: { sha: string } }>(`/repos/${repo}/branches/${branch}`)).commit.sha;
  }
  async required(repo: string, branch: 'dev' | 'uat'): Promise<RequiredCheck[]> {
    // GitHub resolves active branch rules, including rulesets. Legacy protection
    // is read too because older repositories only configure that API.
    const required = new Map<string, RequiredCheck>();
    let strict = false;
    let nonBypassable = false;
    const add = (check: RequiredCheck) => {
      const prior = required.get(check.context);
      if (prior?.app_id && prior.app_id !== -1 && check.app_id && check.app_id !== -1 && prior.app_id !== check.app_id) {
        throw new DeliveryError('Required CI policies disagree on the check provider. Resolve the rules before delivery.');
      }
      if (!prior?.app_id || prior.app_id === -1) required.set(check.context, check);
    };
    try {
      const rules = await this.api.get<Array<{ type: string; ruleset_id?: number; parameters?: { strict_required_status_checks_policy?: boolean; required_status_checks?: Array<{ context: string; integration_id?: number }> } }>>(
        `/repos/${repo}/rules/branches/${branch}?per_page=100`);
      if (rules.length === 100) throw new DeliveryError('Branch rules exceed the bounded policy inspection. Review the repository policy before delivery.');
      for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
        strict ||= rule.parameters?.strict_required_status_checks_policy === true;
        if (rule.parameters?.strict_required_status_checks_policy && rule.ruleset_id) {
          const policy = await this.api.get<{ enforcement: string; bypass_actors?: unknown[] }>(`/repos/${repo}/rulesets/${rule.ruleset_id}?includes_parents=true`);
          nonBypassable ||= policy.enforcement === 'active' && Array.isArray(policy.bypass_actors) && policy.bypass_actors.length === 0;
        }
        for (const check of rule.parameters?.required_status_checks ?? []) {
          add({ context: check.context, app_id: check.integration_id });
        }
      }
    } catch (error) { if (!(error instanceof GitHubApiError) || error.status !== 404) throw error; }
    try {
      const policy = await this.api.get<{ enforce_admins?: { enabled: boolean }; required_status_checks: { strict?: boolean; contexts?: string[]; checks?: RequiredCheck[] } | null }>(
        `/repos/${repo}/branches/${branch}/protection`);
      strict ||= policy.required_status_checks?.strict === true;
      nonBypassable ||= policy.required_status_checks?.strict === true && policy.enforce_admins?.enabled === true;
      for (const check of policy.required_status_checks?.checks ?? []) add(check);
      for (const context of policy.required_status_checks?.contexts ?? []) {
        if (!required.has(context)) required.set(context, { context });
      }
    } catch (error) { if (!(error instanceof GitHubApiError) || error.status !== 404) throw error; }
    if (!required.size) throw new DeliveryError(`${repo}: no required CI checks are configured for ${branch}. Configure branch protection or a ruleset first.`);
    if (!strict) throw new DeliveryError(`${repo}: ${branch} must require branches to be up to date before merging (strict required checks).`);
    if (!nonBypassable) throw new DeliveryError(`${repo}: ${branch} strict checks must also apply to administrators, or use an active ruleset with a verified empty bypass list.`);
    return [...required.values()];
  }
  async checks(repo: string, sha: string, branch: 'dev' | 'uat', mergeSha?: string | null) {
    const required = await this.required(repo, branch);
    const read = async (commit: string) => {
      const readRuns = async () => {
        const runs: CheckRun[] = [];
        for (let page = 1; page <= 50; page++) {
          const result = await this.api.get<{ total_count: number; check_runs: CheckRun[] }>(
            `/repos/${repo}/commits/${commit}/check-runs?filter=latest&per_page=100&page=${page}`);
          if (result.total_count > 5000) throw new DeliveryError('Too many CI checks to verify safely. Narrow the delivery policy.');
          runs.push(...result.check_runs);
          if (runs.length >= result.total_count) return runs;
          if (!result.check_runs.length) throw new DeliveryError('CI check pagination is incomplete. Refresh before continuing.');
        }
        throw new DeliveryError('CI check pagination is incomplete.');
      };
      const [runs, statuses] = await Promise.all([
        readRuns(),
        this.api.getAll<Status>(`/repos/${repo}/commits/${commit}/statuses?per_page=100`)
      ]);
      const checks = new Map<string, DeliveryCheck>();
      for (const run of runs) {
        const policy = required.find(item => item.context === run.name);
        if (policy?.app_id && policy.app_id !== -1 && policy.app_id !== run.app?.id) continue;
        if (checks.has(run.name)) continue;
        checks.set(run.name, { name: run.name, state: run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'passed' : 'failed', url: run.html_url });
      }
      // Statuses arrive newest first. A success from a previous attempt must
      // never hide its later failure. App-bound checks cannot be spoofed by statuses.
      for (const status of statuses) {
        const policy = required.find(item => item.context === status.context);
        if (checks.has(status.context) || (policy?.app_id && policy.app_id !== -1)) continue;
        checks.set(status.context, { name: status.context, state: status.state === 'success' ? 'passed' : status.state === 'pending' ? 'pending' : 'failed', url: status.target_url });
      }
      return checks;
    };
    const checks = await read(sha);
    if (mergeSha && mergeSha !== sha) for (const [name, check] of await read(mergeSha)) checks.set(name, check);
    const names = required.map(check => check.context);
    for (const name of names) if (!checks.has(name)) checks.set(name, { name, state: 'pending' });
    const values = [...checks.values()];
    return { checks: values, required: names, state: checksState(values, names) };
  }
  async assertScope(repo: string, number: number) {
    const files = await this.api.getAll<{ filename: string; previous_filename?: string }>(`/repos/${repo}/pulls/${number}/files?per_page=100`);
    if (files.some(file => [file.filename, file.previous_filename ?? ''].some(name => name.startsWith('.github/workflows/')))) {
      throw new DeliveryError(`${repo}: this PR changes workflows and needs a separate human review. Automatic delivery will not merge it.`);
    }
  }
  async merge(repo: string, pull: DeliveryPull, expectedHead: string, expectedBase: string) {
    // Re-read immediately before mutation. GitHub's SHA precondition pins the
    // source; required checks and branch protection enforce base integration.
    const current = await this.pull(repo, pull.number);
    if (current.merged && current.head.sha === expectedHead) return current.merge_commit_sha!;
    if (current.head.sha !== expectedHead || current.base.sha !== expectedBase || current.state !== 'open' || current.mergeable !== true) {
      throw new DeliveryError(`${repo}: the pull request changed or cannot merge. Refresh its evidence.`);
    }
    const result = await this.api.put<{ merged: boolean; sha: string; message?: string }>(`/repos/${repo}/pulls/${pull.number}/merge`,
      { sha: expectedHead, merge_method: 'merge' });
    if (!result.merged) throw new DeliveryError(`${repo}: GitHub did not merge the pull request.`);
    return result.sha;
  }
  async prepareUat(repo: string) {
    const pulls = await this.api.get<DeliveryPull[]>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':dev')}&base=uat`);
    if (pulls[0]) return this.pull(repo, pulls[0].number);
    return this.api.post<DeliveryPull>(`/repos/${repo}/pulls`, { head: 'dev', base: 'uat', title: 'Promote dev → uat',
      body: 'Prepared by Alpha for PM review. Promotion requires passing CI and explicit authorization for the current source and target commits. This is not client acceptance.' });
  }
}
