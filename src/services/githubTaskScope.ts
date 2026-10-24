import { isSecretFile } from './projectFiles.js';

const READ_TOOLS = new Set(['github_check_access', 'github_list_branches', 'github_read_file',
  'github_workflow_runs', 'github_failed_run_logs', 'github_repo_tree', 'github_compare_branches', 'github_list_pull_requests']);
export function githubToolWithinScope(name: string, repositories: readonly string[] | undefined, args?: Record<string, unknown>): boolean {
  if (repositories === undefined) return true;
  if (!READ_TOOLS.has(name)) return false;
  if (!args) return true;
  if (typeof args.repo !== 'string' || !repositories.some(repo => repo.toLowerCase() === (args.repo as string).trim().toLowerCase())) return false;
  if (name === 'github_read_file' && (typeof args.path !== 'string' || args.path.split(/[\\/]/).some(part => part === '..' || part === '.git' || isSecretFile(part)))) return false;
  return true;
}
