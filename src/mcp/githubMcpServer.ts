/**
 * Alpha's GitHub MCP server.
 *
 * Runs as a short-lived stdio subprocess of whichever agent CLI is executing a
 * turn, and exposes `githubService` as MCP tools. Two consequences of building
 * on that service rather than shelling to `gh` directly:
 *
 *   * It works in both deployments. `githubService` dispatches on auth mode —
 *     `gh` on the desktop, REST/GitHub App on a hosted container — so the same
 *     tools resolve correctly in either, with no second credential path.
 *   * Alpha handles no token. On the desktop `gh` reads the OS keyring itself;
 *     nothing passes through this process, no config file, no env var.
 *
 * ## What this server is for, now that it is not read-only
 *
 * It used to mutate nothing, on the grounds that pushing and opening pull
 * requests "need an approval story this layer does not have". The approval
 * story turned out to be the part that was already there — the review gate,
 * where a person approves a run and Alpha merges — and the read-only stance was
 * guarding the wrong door: a run gets `--dangerously-skip-permissions`, so the
 * agent could already `git push` and `gh pr merge` from Bash, unrecorded.
 *
 * So the two mutations here are the ones tied to the local checkout, and only
 * those. `github_push_branch` and `github_open_pull_request` need to know which
 * directory this turn is working in, which no remote server can know. Anything
 * purely remote — issues, reviews, workflow reruns — belongs to GitHub's own
 * MCP server, registered in the catalog as `github-read` / `github-write`,
 * which is maintained by GitHub and covers far more than this could.
 *
 * Merging is still absent, deliberately. It is the one irreversible act, and it
 * belongs to the person at the review gate rather than to the agent that wrote
 * the code. Pushing to a protected branch is refused for the same reason: every
 * other guard in Alpha assumes work arrives by pull request.
 *
 * Alpha still handles no token for any of this — `gh` reads the OS keyring
 * itself. That is the property the hosted GitHub server gives up, and the
 * reason this one continues to exist alongside it.
 *
 * The JSON-RPC is hand-rolled rather than taken from @modelcontextprotocol/sdk
 * because that package is ESM-only and this backend compiles to CommonJS. The
 * tools-only subset of MCP is four methods, so the dependency bought less than
 * the module-system mismatch cost.
 *
 * Entry point only — nothing imports this. It is spawned by the per-run config
 * that `mcpConfigService` writes.
 */
import { createInterface } from 'node:readline';
import { githubToolWithinScope } from '../services/githubTaskScope.js';

import { githubService } from '../services/githubService.js';
import { cloneIntoProjectFolder, cloneToWorkspace } from '../services/repoCloneService.js';
import { getCurrentBranch, remoteHasDevBranch } from '../utils/gitUtils.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubApiWithToken, type GitHubApi } from '../services/githubApi.js';
import {
  AGENT_BRANCH_PREFIX,
  compareBranches,
  createAgentBranch,
  getTree,
  listPullRequests
} from '../services/githubRepoWorkspace.js';
import { sqliteService } from '../services/sqliteService.js';

/**
 * Record a mutation where the UI can find it.
 *
 * Written straight to alpha.db from this process rather than reported back to
 * the daemon. This server is a grandchild of the daemon with no channel to it —
 * its stdout belongs to the MCP protocol — and the database is already the
 * shared store. WAL mode and the busy timeout in initPragmas are what make a
 * second writer safe.
 *
 * The run id comes from the environment because that is the only thing tying
 * this process to the work it is doing; the agent and issue are read from the
 * run, so a caller cannot misattribute an action to someone else.
 */
function audit(action: string, target: string | undefined, succeeded: boolean, detail?: string) {
  const runId = process.env.ALPHA_RUN_ID;
  const run = runId ? sqliteService.getPrototypeRuns().find(r => r.id === runId) : undefined;

  sqliteService.recordRemoteAction({
    runId,
    agentId: run?.agentId,
    issueId: run?.issueId,
    actor: 'agent',
    action,
    target,
    detail,
    succeeded
  });
}

/**
 * The checkout this turn is working in.
 *
 * Supplied by `writeRunMcpConfig` in the server's own environment rather than
 * inherited: this process is a grandchild of Alpha — Alpha spawns the agent
 * CLI, the CLI spawns this — and nothing in that chain promises to carry a
 * working directory. A push tool that guesses wrong pushes the wrong
 * repository.
 */
function requireWorkspace(): string {
  const cwd = process.env.ALPHA_WORKSPACE;
  if (!cwd) {
    throw new Error(
      'This turn has no workspace, so there is nothing to commit or push. ' +
        'Local changes need a project with a working copy on this machine.'
    );
  }
  return cwd;
}

/**
 * Branches an agent must never push to directly.
 *
 * Checked by name as well as by asking the remote, because the remote lookup
 * needs a network call and a resolvable `owner/repo`, and neither is
 * guaranteed. A guard that silently stops working when the remote is
 * unreachable is not a guard.
 */
const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'develop', 'trunk', 'dev', 'uat']);

/**
 * The REST API as this process's GitHub account.
 *
 * This server is spawned by the agent's CLI: it has no request and no Alpha
 * session of its own, only the `gh` configuration the daemon handed it, so
 * the token comes from `gh` -- the same identity every other tool here uses.
 */
let restApi: Promise<GitHubApi> | undefined;
function api(): Promise<GitHubApi> {
  restApi ??= promisify(execFile)('gh', ['auth', 'token'], { timeout: 10_000, windowsHide: true }).then(({ stdout }) => {
    const token = String(stdout).trim();
    if (!token) throw new Error('No GitHub account is available to this agent.');
    return githubApiWithToken(token);
  });
  return restApi;
}

/** The branch pull requests target, when it can be determined. */
async function remoteDefaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const { ownerRepo } = await githubService.inspectLocalRepo(cwd);
    if (!ownerRepo) return undefined;
    return (await githubService.getRepository(ownerRepo)).defaultBranch;
  } catch {
    // No remote, no network, or a private repo the account cannot read. The
    // name check below still applies.
    return undefined;
  }
}

/** Newest protocol version this server implements. */
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => Promise<unknown>;
  /** Provider-neutral MCP hint so each CLI treats reads consistently. */
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  /**
   * Omitted means readable by anyone who can reach this server. Only the tools
   * that change a remote (push, branch, pull request, posted review) carry 'write'.
   */
  access?: 'write';
}

/**
 * What this turn may do, decided by the daemon and passed in the environment.
 *
 * Read here rather than negotiated, because this process cannot be trusted to
 * ask: it is spawned by the agent's own CLI. Anything other than an explicit
 * 'write' is read — an absent or misspelled value must not widen access.
 */
const ACCESS: 'read' | 'write' = process.env.ALPHA_MCP_ACCESS === 'write' ? 'write' : 'read';

const permitted = (t: ToolDef) => t.access !== 'write' || ACCESS === 'write';

/**
 * The selected project's folder on this computer and its repositories, when
 * the turn has a project. Its repositories are cloned there; anything else
 * goes to Alpha's own workspace as before.
 */
const PROJECT_FOLDER = process.env.ALPHA_PROJECT_FOLDER?.trim() || '';
const PROJECT_REPOS: string[] = (() => {
  try {
    const parsed = JSON.parse(process.env.ALPHA_PROJECT_REPOS ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
})();
const inProject = (repo: string) => PROJECT_FOLDER !== '' && PROJECT_REPOS.some(item => item.toLowerCase() === repo.trim().toLowerCase());
const SCOPED_REPOS: string[] | undefined = process.env.ALPHA_SCOPED_REPOS === undefined ? undefined : (() => {
  try { const value: unknown = JSON.parse(process.env.ALPHA_SCOPED_REPOS!); return Array.isArray(value) && value.every(repo => typeof repo === 'string') ? value : []; } catch { return []; }
})();

const str = (description: string) => ({ type: 'string', description });
const int = (description: string, min: number, max: number) => ({
  type: 'integer',
  description,
  minimum: min,
  maximum: max
});

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const TOOLS: Record<string, ToolDef> = {
  github_check_access: {
    description:
      'Check whether the signed-in GitHub account can reach a repository. Returns its default branch, visibility, and whether it is empty. Use this first when asked whether a repo is reachable.',
    inputSchema: schema({ repo: str('Repository as owner/name, e.g. octocat/hello-world') }, ['repo']),
    run: async ({ repo }) => {
      const info = await githubService.getRepository(repo);
      return {
        reachable: true,
        ...info,
        ...(info.isEmpty ? { note: 'Repository exists but has no commits yet.' } : {})
      };
    }
  },

  github_list_branches: {
    description: 'List branches on a remote repository, with whether each is protected.',
    inputSchema: schema(
      { repo: str('Repository as owner/name'), limit: int('Max branches (default 50)', 1, 100) },
      ['repo']
    ),
    run: ({ repo, limit }) => githubService.listBranches(repo, limit)
  },

  github_read_file: {
    description: 'Read a single file from a remote repository without cloning it.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        path: str('File path inside the repository, e.g. .github/workflows/ci.yml'),
        ref: str('Branch, tag or commit SHA. Defaults to the default branch.')
      },
      ['repo', 'path']
    ),
    run: ({ repo, path, ref }) => githubService.getFileContents(repo, path, ref)
  },

  github_list_repositories: {
    description: 'List repositories the signed-in account can see.',
    inputSchema: schema({ limit: int('Max repositories (default 30)', 1, 100) }),
    run: ({ limit }) => githubService.listRepositories(limit)
  },

  github_list_organizations: {
    description:
      'List GitHub organizations the signed-in account belongs to, with the role held in each.',
    inputSchema: schema({}),
    run: () => githubService.listOrganizations()
  },

  github_workflow_runs: {
    description:
      'List recent GitHub Actions runs for a repository or local checkout, with status and conclusion.',
    inputSchema: schema({
      repo: str('Repository as owner/name, or a local path. Defaults to the current workspace.'),
      limit: int('Max runs (default 15)', 1, 50)
    }),
    run: ({ repo, limit }) => githubService.getWorkflowRuns(repo, limit)
  },

  github_failed_run_logs: {
    description:
      'Fetch log output of the failed steps in a workflow run. Use after github_workflow_runs identifies a failure.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name, or a local path'),
        runId: str('Workflow run id from github_workflow_runs')
      },
      ['repo', 'runId']
    ),
    run: ({ repo, runId }) => githubService.getFailedWorkflowLogs(repo, runId)
  },

  github_push_branch: {
    access: 'write',
    description:
      'Commit everything you have changed in this workspace and push it to the branch you are on. Use when your work is ready for others to see. Alpha knows which repository and branch — do not pass a path and do not run git yourself. Refuses to push to the default branch.',
    inputSchema: schema(
      { message: str('Commit message. One line, imperative, describing what changed.') },
      ['message']
    ),
    run: async ({ message }) => {
      const cwd = requireWorkspace();
      const branch = await getCurrentBranch(cwd);

      /**
       * Never the default branch.
       *
       * Every other guard in Alpha assumes work arrives by pull request — the
       * review gate, the diff shown for approval, the one-PR-per-issue rule.
       * An agent pushing straight to main walks past all of them, and nothing
       * downstream would notice.
       */
      const defaultBranch = await remoteDefaultBranch(cwd);
      if (PROTECTED_BRANCH_NAMES.has(branch) || (defaultBranch && branch === defaultBranch)) {
        audit('push', branch, false, 'Refused: protected branch.');
        throw new Error(
          `Refusing to push to "${branch}", which is a protected branch. Work reaches it by pull request. ` +
            `You are on the wrong branch — Alpha put you on a feature branch for this task.`
        );
      }

      let committed: boolean;
      try {
        committed = await githubService.commitAndPush(cwd, branch, message);
      } catch (err: any) {
        audit('push', branch, false, String(err?.message ?? err));
        throw err;
      }

      audit('push', branch, true, committed ? message : 'Nothing new to commit; branch pushed.');
      return {
        branch,
        committed,
        note: committed
          ? `Committed and pushed to ${branch}.`
          : `Nothing left to commit — ${branch} was already up to date and has been pushed.`
      };
    }
  },

  github_open_pull_request: {
    access: 'write',
    description:
      'Open a pull request for the branch you are working on. Use after github_push_branch, when the work is complete and ready for review. Returns the pull request URL.',
    inputSchema: schema(
      {
        title: str('Pull request title. One line, describing the change.'),
        body: str('Pull request description: what changed and why, in markdown.'),
        base: str('Branch to merge into. Defaults to the repository default branch.')
      },
      ['title', 'body']
    ),
    run: async ({ title, body, base }) => {
      const cwd = requireWorkspace();
      const head = await getCurrentBranch(cwd);
      const pipeline = await remoteHasDevBranch(cwd);
      // A pipeline repository takes agent work into dev; promotion to uat and
      // main is a project manager's pull request, never an agent's.
      const target = base || (pipeline ? 'dev' : await remoteDefaultBranch(cwd)) || 'main';
      if (pipeline && (target === 'uat' || target === 'main')) {
        audit('open_pull_request', head, false, `Refused: ${target} is a promotion target.`);
        throw new Error(
          `Refusing to open a pull request into "${target}". In this repository work goes into dev, and a project manager promotes dev to uat and uat to main.`
        );
      }

      if (head === target) {
        throw new Error(
          `Cannot open a pull request from "${head}" into itself. Your changes need to be on a feature branch.`
        );
      }

      let url: string;
      try {
        url = await githubService.createPullRequest(cwd, title, body, target, head);
      } catch (err: any) {
        audit('open_pull_request', head, false, String(err?.message ?? err));
        throw err;
      }

      audit('open_pull_request', url, true, `${head} into ${target}`);
      return { url, head, base: target };
    }
  },

  github_repo_tree: {
    description:
      'List every file and folder of a remote repository at a branch, tag or commit, without cloning it. Use to find your way around a branch you are not checked out on.',
    inputSchema: schema(
      { repo: str('Repository as owner/name'), ref: str('Branch, tag or commit SHA, e.g. dev') },
      ['repo', 'ref']
    ),
    run: async ({ repo, ref }) => getTree(repo, ref, await api())
  },

  github_compare_branches: {
    description:
      'Compare two branches of a remote repository: how far head is ahead of and behind base, its commits, and the files changed. Set patches to include the diff of each file.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        base: str('Branch to compare against, e.g. main'),
        head: str('Branch with the changes, e.g. dev'),
        patches: { type: 'boolean', description: 'Include each file diff (default false)' }
      },
      ['repo', 'base', 'head']
    ),
    run: async ({ repo, base, head, patches }) => compareBranches(repo, base, head, { patches: Boolean(patches) }, await api())
  },

  github_list_pull_requests: {
    description: 'List pull requests of a remote repository, with their head and base branches. Promotion PRs (dev->uat, uat->main) are marked.',
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' }
      },
      ['repo']
    ),
    run: async ({ repo, state }) => listPullRequests(repo, state ?? 'open', await api())
  },

  github_create_agent_branch: {
    access: 'write',
    description:
      `Create a branch on the remote for a separate piece of work, from dev by default. The name must start with "${AGENT_BRANCH_PREFIX}" (e.g. ${AGENT_BRANCH_PREFIX}reviewer/fix-login); dev, uat and main cannot be created or moved.`,
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        name: str(`Branch name, starting with ${AGENT_BRANCH_PREFIX}`),
        from: str('Branch to start from (default dev)')
      },
      ['repo', 'name']
    ),
    run: async ({ repo, name, from }) => {
      try {
        const created = await createAgentBranch(repo, name, from || 'dev', await api());
        audit('create_branch', `${repo}:${created.name}`, true, `from ${created.from}`);
        return created;
      } catch (err: any) {
        audit('create_branch', `${repo}:${name}`, false, String(err?.message ?? err));
        throw err;
      }
    }
  },

  github_review_pull_request: {
    // Posting a review writes to GitHub, so a read-only turn (the Orchestrator's chat) must not.
    access: 'write',
    description:
      'Post a code review on a pull request. Use when asked to review work — read the diff first, then say what you found. ' +
      'State your verdict as the first line: APPROVE, REQUEST CHANGES, or COMMENT, followed by the reasoning and any specific problems. ' +
      'This posts a review comment; it does not approve or merge anything, and a person still decides at the review gate.',
    inputSchema: schema(
      {
        pull_request: str('Pull request URL, or its number as a string.'),
        body: str('The review, in markdown. Begin with APPROVE, REQUEST CHANGES, or COMMENT.')
      },
      ['pull_request', 'body']
    ),
    run: async ({ pull_request, body }) => {
      const cwd = requireWorkspace();

      try {
        await githubService.reviewPullRequest(cwd, String(pull_request), body);
      } catch (err: any) {
        audit('review_pull_request', String(pull_request), false, String(err?.message ?? err));
        throw err;
      }

      /*
       * The verdict is recorded as Alpha's own fact, not GitHub's. GitHub sees
       * a comment — it will not accept an approval from the account that opened
       * the pull request, which is the same account every agent uses. So the
       * trail that says a reviewer approved lives here, where the identities
       * are actually distinct.
       */
      const firstLine = String(body).trim().split('\n')[0].trim().slice(0, 120);
      audit('review_pull_request', String(pull_request), true, firstLine);

      return {
        pull_request,
        posted: true,
        note: 'Posted as a review comment. Approval and merge remain with the person at the review gate.'
      };
    }
  },

  github_clone_repository: {
    description:
      "Clone a repository onto this machine so its files can be worked on locally. Alpha chooses the destination — do not ask for a path and do not run git yourself. The selected project's repositories go into the project's folder on this computer, and a copy already there is left untouched. Other repositories go into Alpha's managed workspace, where an existing checkout is refreshed. Returns the local path.",
    inputSchema: schema(
      {
        repo: str('Repository as owner/name'),
        ref: str('Branch to check out. Defaults to the repository default branch.')
      },
      ['repo']
    ),
    run: async ({ repo, ref }) => {
      const result = inProject(repo)
        ? await cloneIntoProjectFolder(repo, PROJECT_FOLDER, ref)
        : await cloneToWorkspace(repo, ref);
      return {
        ...result,
        note:
          result.action === 'existing'
            ? "Already in the project's folder; left as it was."
            : result.action === 'refreshed'
              ? 'An existing checkout was reset to the remote state.'
              : inProject(repo) ? "Cloned into the project's folder." : 'Cloned fresh.'
      };
    }
  },

  github_auth_status: {
    description:
      'Report how Alpha is authenticated to GitHub and as whom. Use when a call fails and the cause may be sign-in rather than permissions.',
    inputSchema: schema({}),
    run: () => githubService.checkAuth()
  }
};

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────────

type Id = string | number | null;

function send(message: Record<string, unknown>): void {
  realWrite(JSON.stringify(message) + '\n');
}

function reply(id: Id, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: Id, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * A failing tool answers with `isError` content rather than a JSON-RPC error.
 *
 * A protocol error is invisible to the model — the CLI reports "tool failed"
 * and the turn stalls. "Cannot reach owner/repo, it may be private" is exactly
 * what the agent should be relaying back, so it belongs in the content.
 */
function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};

  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        // Echo the client's version when we speak it, so an older CLI is not
        // forced onto a newer one it may not parse.
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alpha-github', version: '1.0.0' }
      });
    }

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      /*
       * Filtered, not merely refused on call. A tool the agent can see is one
       * it will plan around and describe to the user before discovering it is
       * denied — and a run that narrates opening a pull request it cannot open
       * reads as a lie rather than a limit.
       */
      return reply(id, {
        tools: Object.entries(TOOLS)
          .filter(([name, t]) => permitted(t) && githubToolWithinScope(name, SCOPED_REPOS))
          .map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations ?? {
              readOnlyHint: t.access !== 'write',
              destructiveHint: false,
              openWorldHint: true
            }
          }))
      });

    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) {
        return reply(id, toolResult(`Unknown tool: ${name}`, true));
      }
      if (!githubToolWithinScope(name, SCOPED_REPOS, params?.arguments ?? {})) {
        return reply(id, toolResult('This tool or repository is outside the selected project’s read-only GitHub scope.', true));
      }
      /*
       * Checked again here. The list above is advice to a client that may have
       * cached an older one; this is the boundary.
       */
      if (!permitted(tool)) {
        audit(name, undefined, false, 'Refused: this agent has read-only remote access.');
        return reply(
          id,
          toolResult(
            `"${name}" changes a remote, and this turn has read-only access to GitHub. ` +
              `Commit your work locally and describe what you changed — a person will push it. ` +
              `Raising an agent's autonomy above Supervised is what grants this.`,
            true
          )
        );
      }
      try {
        const value = await tool.run(params?.arguments ?? {});
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return reply(id, toolResult(text));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }

    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * stdout is the transport. `githubService` logs through the shared logger,
 * which writes to stdout via console.log — one such line between two frames
 * corrupts the stream and the CLI drops the server. Route console output to
 * stderr, and keep a private handle to the real writer for frames.
 */
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
console.debug = console.log;

const rl = createInterface({ input: process.stdin });

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // A frame we cannot parse has no id to answer against; the spec's parse
    // error uses a null id.
    return replyError(null, -32700, 'Parse error');
  }

  handle(msg).catch(err => {
    replyError(msg?.id ?? null, -32603, err?.message ?? String(err));
  });
});

rl.on('close', () => process.exit(0));
