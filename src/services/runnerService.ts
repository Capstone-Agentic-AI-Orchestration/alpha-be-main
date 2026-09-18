import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sqliteService } from './sqliteService.js';
import { ProcessTerminationReason, processManager } from './processManager.js';
import { classifyProcessExit } from './runLifecycle.js';
import { StreamParser, RunTelemetry } from './streamParser.js';
import { buildTurnInvocation, writeTurnPersona } from './cliRunner.js';
import { resolveAgentLogged } from './personaService.js';
import { resolveProjectWorkspace, allowAttachedWorkspace } from './workspaceService.js';
import { agentReadiness } from './agentReadiness.js';
import { buildEnv } from './customCliArgs.js';
import { mergeUsage, hasUsage } from './runUsage.js';
import { writeRunMcpConfig, cleanupRunMcpConfig } from './mcpConfigService.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { createBranch, checkoutBranch, getGitDiffStats, isGitRepo } from '../utils/gitUtils.js';
import { githubService } from './githubService.js';
import { supabaseService } from './supabaseService.js';
import { updateIssueAndPush } from './boardWriteThrough.js';
import { mcpAccessFor, McpAccess } from './autonomyPolicy.js';
import { isFinalSquadMember } from './squadPosition.js';
import { workspaceQueue } from './workspaceQueue.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, PrototypeRunStage, StageId, Issue, RunActivity, RunActivityKind } from '../models/index.js';
import { RUNS_DIR } from '../config/env.js';

export interface StartRunParams {
  issueId: string;
  agentId: string;
  plan: string[];
  scenario?: 'success' | 'test_failure' | 'review_required';
  /**
   * Present when this run is one member's turn inside a squad run.
   *
   * A squad shares one branch across every member, so the branch is decided by
   * the squad run and passed in rather than generated per run — and only the
   * first member may create it. See SquadMemberContext.
   */
  squad?: SquadMemberContext;
}

export interface SquadMemberContext {
  squadRunId: string;
  /** 0-based position in the squad's order. */
  order: number;
  /** The shared branch. Created by order 0; checked out by everyone after. */
  branchName: string;
  /**
   * What the members before this one did, already written up. Empty for the
   * first member.
   *
   * A written handoff rather than a replayed transcript: the previous member's
   * actual work is on the branch, which this member can read with its own
   * tools, so the prompt only has to say what happened and who did it. The
   * transcript alternative costs 5k-20k tokens per member and mostly restates
   * what the diff already shows.
   */
  handoff: string;
}

/** Control-flow marker: this member is not the one that opens the PR. */
class SkipPullRequest extends Error {}

export class RunnerService extends EventEmitter {
  /**
   * Start autonomous execution for an issue
   */
  async startRun(params: StartRunParams): Promise<PrototypeRun> {
    const { issueId, agentId, plan, scenario = 'success' } = params;

    const issue = sqliteService.getIssues().find(i => i.id === issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);

    const agent = sqliteService.getAgents().find(a => a.id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const project = sqliteService.getProjects().find(p => p.id === issue.projectId);
    if (!project) throw new Error(`Project not found: ${issue.projectId}`);

    /**
     * The working directory, from the project's own resources and nothing else.
     *
     * Shared with chat so an agent reviewing a project in conversation looks at
     * the same directory a run would edit. The reasoning for having no fallback
     * lives with the resolver — see `resolveProjectWorkspace`.
     */
    const workspace = resolveProjectWorkspace(project);

    if (!workspace) {
      throw new Error(
        `Project "${project.name}" has no working copy. Attach a local folder, or clone one of its repositories, before running an agent.`
      );
    }

    const cwd = workspace.dir;

    if (!fs.existsSync(cwd)) {
      throw new Error(`Working copy for "${project.name}" is missing from disk: ${cwd}`);
    }

    allowAttachedWorkspace(workspace, project.name);

    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();
    /**
     * A squad's members all commit to the branch the squad run opened. Only a
     * lone agent gets a fresh one.
     */
    const branchName =
      params.squad?.branchName ??
      `feat/${issue.identifier.toLowerCase()}-${Date.now().toString().slice(-4)}`;

    /**
     * Is anything already using this checkout?
     *
     * Asked before enqueuing, because the answer decides what this run honestly
     * is: started, or waiting for a directory somebody else holds.
     */
    const queuedBehind = workspaceQueue.depth(cwd);
    const waitNote = queuedBehind === 1
      ? 'Waiting for 1 earlier run to finish in this workspace.'
      : `Waiting for ${queuedBehind} earlier runs to finish in this workspace.`;

    const stages: PrototypeRunStage[] = [
      queuedBehind
        ? { id: 'workspace', label: 'Preparing workspace', description: 'Checking out branch and initializing environment.', status: 'pending', logs: [`Target repository: ${cwd}`, waitNote] }
        : { id: 'workspace', label: 'Preparing workspace', description: 'Checking out branch and initializing environment.', status: 'running', logs: [`Target repository: ${cwd}`, `Checking out branch: ${branchName}`], startedAt: now },
      { id: 'analysis', label: 'Analyzing context', description: 'Inspecting repository files, dependencies, and requirements.', status: 'pending', logs: [] },
      { id: 'implementation', label: 'Implementing changes', description: 'Applying code edits and generating required files.', status: 'pending', logs: [] },
      { id: 'tests', label: 'Running verification tests', description: 'Executing test suites, linting, and typechecks.', status: 'pending', logs: [] },
      { id: 'review', label: 'Preparing review', description: 'Summarizing changes, calculating diffs, and staging PR.', status: 'pending', logs: [] }
    ];

    const runRecord: PrototypeRun = {
      id: runId,
      issueId,
      projectId: project.id,
      agentId,
      status: queuedBehind ? 'queued' : 'running',
      scenario,
      plan,
      currentStageIndex: 0,
      stages,
      activities: [{
        id: `${runId}:activity:0`,
        sequence: 0,
        kind: 'status',
        message: queuedBehind ? `Run queued. ${waitNote}` : 'Run accepted and workspace preparation started.',
        stageId: 'workspace',
        createdAt: now
      }],
      branchName,
      squadRunId: params.squad?.squadRunId,
      squadOrder: params.squad?.order,
      createdAt: now,
      updatedAt: now
    };

    sqliteService.savePrototypeRun(runRecord);
    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(runRecord).catch(err => logError('Supabase run sync warning:', err));
    }

    // Update Issue status
    updateIssueAndPush(issueId, {
      status: 'agent_running',
      assignedAgentId: agentId,
      branchName
    });
    if (supabaseService.isConfigured()) {
      supabaseService.updateIssueInCloud(issueId, { status: 'agent_running', branchName }).catch(() => {});
    }

    sqliteService.addIssueComment({
      id: `comm-${runId}-start`,
      issueId,
      authorType: 'agent',
      authorName: agent.name,
      authorAvatar: agent.avatar,
      agentId: agent.id,
      // Says what is true right now. A run that is waiting for the workspace
      // has not started anything, and the comment is a permanent record.
      content: queuedBehind
        ? `Queued for **${issue.identifier}** (${issue.title}) on branch \`${branchName}\`. ${waitNote}`
        : `Started autonomous execution for **${issue.identifier}** (${issue.title}) on branch \`${branchName}\`.`,
      createdAt: now,
      isThinking: true
    });

    /**
     * Executed in the background, but one at a time per working directory.
     *
     * Every run for this project checks out its branch in `cwd`, and `cwd` is
     * the same directory for all of them. Before the queue, a second run's
     * `git checkout -B` moved the working tree while the first agent was still
     * editing it, and both wrote to whichever branch was current. Runs in other
     * projects are unaffected: they have their own directory and their own
     * queue.
     */
    workspaceQueue
      .run(cwd, async () => {
        // Waiting is over; say so before the first stage moves.
        const queued = sqliteService.getPrototypeRuns().find(r => r.id === runId);
        if (queued?.status === 'queued') this.markRunStarted(runId);

        await this.executeTask({
          runId,
          issue,
          agent,
          project,
          cwd,
          branchName,
          plan,
          squad: params.squad
        });
      }, {
        // A queued run can be cancelled while an earlier run owns the
        // checkout. Check again at the front of the queue so cancellation
        // prevents the process from ever being spawned.
        shouldStart: () => {
          const latest = sqliteService.getPrototypeRuns().find(r => r.id === runId);
          return !!latest && (latest.status === 'queued' || latest.status === 'running');
        }
      })
      .catch(err => {
        logError(`Execution error in run ${runId}:`, err);
        this.markRunFailed(runId, err.message);
      });

    return runRecord;
  }

  private async executeTask(ctx: {
    runId: string;
    issue: Issue;
    agent: any;
    project: any;
    cwd: string;
    branchName: string;
    plan: string[];
    squad?: SquadMemberContext;
  }) {
    const { runId, issue, agent, cwd, branchName, plan } = ctx;

    /**
     * 1. Get onto the branch — creating it only when this run owns it.
     *
     * `createBranch` runs `git checkout -B`, which force-moves the branch to
     * HEAD. For a lone agent that is correct. For squad member two it would
     * throw away every commit member one had just made, so anyone after the
     * first checks out what is already there.
     */
    const ownsBranch = !ctx.squad || ctx.squad.order === 0;
    try {
      if (ownsBranch) {
        await createBranch(cwd, branchName);
        this.appendLog(runId, 'workspace', `Created and checked out branch: ${branchName}`);
      } else {
        await checkoutBranch(cwd, branchName);
        this.appendLog(runId, 'workspace', `Continuing on the squad's branch: ${branchName}`);
      }
    } catch (err: any) {
      this.appendLog(runId, 'workspace', `Git branch checkout notice: ${err.message}`);
    }

    this.advanceStage(runId, 'workspace', 'success');
    this.advanceStage(runId, 'analysis', 'running');

    // 3. Prepare run directory for per-run configs
    const runDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });

    /**
     * 4. Resolve the agent, then build the invocation with the same code chat
     *    uses.
     *
     * This method used to build its own argv. It predates `cliRunner`, was
     * never migrated, and had drifted badly: no persona file, no memory, no
     * `--model`, no isolation from the operator's own CLI configuration, and
     * `isCodex ? 'codex' : 'claude'` meant an Antigravity agent silently ran as
     * Claude. Every one of those was fixed in cliRunner and reached chat only.
     *
     * The project key is passed because a run — unlike a chat — belongs to a
     * project, so the Tier 2 memory that `projects/{KEY}/rules.md` holds finally
     * applies. The tool policy is not: it describes a read-only conversation,
     * and a run is allowed to edit.
     */
    /**
     * A run is far more expensive to waste than a chat turn — a workspace is
     * cloned and a branch cut before the CLI is ever spawned — so check the
     * pinned model is one the runtime still offers before going further.
     */
    const readiness = agentReadiness(agent, sqliteService.getRuntimes());
    if (readiness.status === 'stale_model') {
      throw new Error(`${readiness.detail} ${readiness.command ?? ''}`.trim());
    }

    const persona = resolveAgentLogged(agent, {
      projectKey: ctx.project?.key,
      includeToolPolicy: false
    });

    /**
     * The agent's MCP servers, which a run never received.
     *
     * `writeRunMcpConfig(runId, undefined)` stood here with nothing to say it
     * was deliberate. Chat passed `persona.mcpServers` and always had, so
     * granting an agent a server worked when you talked to it and did nothing
     * when it worked a card — the half of Alpha the grant exists for.
     *
     * The environment is layered project-then-agent so one global catalog entry
     * resolves to this project's Supabase (or database, or workspace). The
     * agent wins a collision because it is the narrower of the two: a project
     * value is a default for everyone working the board, and an agent's is a
     * deliberate exception to it.
     */
    const access = mcpAccessFor(persona.autonomyLevel, 'run');
    const { env: projectEnv } = buildEnv(ctx.project?.envVars);
    const { env } = buildEnv(agent.envVars);
    /*
     * The agent's autonomy decides whether its tools may touch the remote.
     * Until now the field was decoration: a Supervised reviewer could push code
     * and open pull requests exactly like a Semi-Autonomous developer.
     */
    const mcp = writeRunMcpConfig(
      runId,
      persona.mcpServers,
      { ...projectEnv, ...env },
      cwd,
      access
    );

    /**
     * Built after the MCP config, because it names the tools this run has.
     * Constructing it earlier meant promising a push tool before knowing
     * whether the agent had been granted one.
     */
    const prompt = this.buildTaskPrompt(issue, plan, ctx.squad?.handoff, mcp.serverNames, access);

    const invocation = buildTurnInvocation(
      {
        runId,
        cwd,
        mode: 'run',
        // Keeps the persona out of argv — see TurnInvocation.stdin.
        personaFile: writeTurnPersona(runId, persona.systemPrompt) ?? undefined,
        provider: persona.modelProvider,
        modelName: persona.modelName,
        reasoningEffort: persona.reasoningEffort,
        systemPrompt: persona.systemPrompt,
        personaName: persona.name,
        prompt,
        priorSession: null,
        env,
        customCliArgs: agent.customCliArgs
      },
      mcp
    );

    const { bin, args, family } = invocation;
    const parser = new StreamParser(family);

    const child = processManager.spawnProcess({
      runId,
      bin,
      args,
      cwd,
      // Agent env first, then the family's isolation overrides — see cliHome.
      env: { ...env, ...invocation.env },
      // The task description is multi-line, so it cannot travel in argv.
      stdin: invocation.stdin,
      onStdout: () => {},
      onExit: async (code, signal, terminationReason) => {
        await this.handleProcessExit(runId, cwd, branchName, issue, code, signal, terminationReason);
      }
    });

    if (child.stdout) {
      createLineBuffer(child.stdout, (line) => {
        const parsedEvents = parser.parseLine(line);
        for (const ev of parsedEvents) {
          if (ev.type === 'stage_transition' && ev.stage) {
            this.advanceStage(runId, ev.stage, 'running');
          } else if (ev.type === 'text_delta' && ev.message) {
            this.appendActivity(runId, {
              kind: 'assistant',
              stageId: ev.stage ?? parser.getCurrentStage(),
              message: ev.message,
              streamKey: ev.streamKey,
              isStreaming: true,
              append: true
            });
          } else if (ev.type === 'log' && ev.message) {
            const currentStage = parser.getCurrentStage();
            this.appendLog(runId, currentStage, ev.message, 'assistant', {
              streamKey: ev.streamKey,
              isStreaming: ev.isStreaming ?? false
            });
          } else if (ev.type === 'tool_call' && ev.toolName) {
            const currentStage = parser.getCurrentStage();
            this.appendLog(
              runId,
              currentStage,
              `[Tool Call] ${ev.toolName}: ${JSON.stringify(ev.toolInput || {})}`,
              'tool',
              {
                detail: JSON.stringify(ev.toolInput || {}),
                activityMessage: this.describeToolActivity(ev.toolName, ev.toolInput)
              }
            );
          } else if (ev.type === 'tool_result' || ev.type === 'error') {
            const currentStage = parser.getCurrentStage();
            this.appendLog(
              runId,
              currentStage,
              `[${ev.type === 'error' ? 'Error' : 'Tool Result'}] ${ev.message || 'No output'}`,
              ev.type === 'error' ? 'error' : 'tool_result'
            );
          } else if (ev.type === 'session' || ev.type === 'rate_limit' || ev.type === 'status') {
            this.appendActivity(runId, {
              kind: 'status',
              stageId: ev.stage ?? parser.getCurrentStage(),
              message: ev.message || (ev.type === 'rate_limit' ? 'Provider rate limit signalled.' : 'Agent session started.')
            });
          } else if (ev.type === 'result' && ev.telemetry) {
            this.recordUsage(runId, ev.telemetry);
            this.appendActivity(runId, {
              kind: ev.telemetry.isError ? 'error' : 'summary',
              stageId: ev.stage ?? parser.getCurrentStage(),
              message: ev.message || (ev.telemetry.isError ? 'Agent reported an error.' : 'Agent turn completed.')
            });
          }
        }
      });
    }

    if (child.stderr) {
      createLineBuffer(child.stderr, (line) => {
        const currentStage = parser.getCurrentStage();
        this.appendLog(runId, currentStage, `[stderr] ${line}`, 'error');
      });
    }
  }

  /**
   * Fold a CLI's reported token counts into the run's stored totals.
   *
   * Written as the numbers arrive rather than held until exit, so a run that is
   * cancelled, times out, or is orphaned by a daemon restart still keeps what
   * it had already spent. Tokens are consumed whether or not the run finishes,
   * and a cancelled run that reports nothing looks free when it was not.
   *
   * Read-then-write with no await in between, so it cannot interleave with the
   * other writers of this row.
   */
  private recordUsage(runId: string, telemetry: RunTelemetry) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

    const usage = mergeUsage(run.usage, telemetry);
    if (!hasUsage(usage)) return;

    sqliteService.savePrototypeRun({ ...run, usage });
  }

  private buildTaskPrompt(
    issue: Issue,
    plan: string[],
    handoff?: string,
    /** MCP servers this run actually has, so the prompt promises only those. */
    mcpServers: string[] = [],
    /** What those servers may do to a remote, which narrows it further. */
    access: McpAccess = 'read'
  ): string {
    const planSection = plan.length > 0
      ? `\n\nExecution Plan:\n${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '';

    // The persona is NOT interpolated here any more: it reaches the model
    // through --append-system-prompt (or, on the families without such a flag,
    // prepended by cliRunner), resolved from the persona file and the memory
    // tiers rather than from the one-line database column this used to read.
    /**
     * What the members before this one did.
     *
     * Placed before the instructions so the agent reads it as established
     * context rather than as part of its own task.
     */
    const handoffSection = handoff ? `

${handoff}` : '';

    /**
     * Say that the shell cannot reach GitHub, and what to use instead.
     *
     * The credentials are stripped from this process (see
     * gitCredentialIsolation), so `git push` fails with an authentication
     * error that reads like a broken machine. An agent that does not know why
     * retries it, tries `gh auth login`, and burns the turn on a wall it
     * cannot climb. Naming the working route costs a sentence.
     *
     * Only stated when the tools are actually granted. Telling an agent to use
     * a tool it does not have is worse than saying nothing.
     */
    /*
     * Granted the server is not the same as allowed to use it. A Supervised
     * agent has alpha-github for its read tools while push and
     * open-pull-request are filtered out of its tool list, so keying this off
     * the server name alone told that agent to call two tools it could not see
     * — the precise contradiction this section exists to avoid.
     */
    const canPush = mcpServers.includes('alpha-github') && access === 'write';
    const remoteSection = canPush
      ? `

Pushing your work:
- \`git\` and \`gh\` in the shell cannot reach GitHub — credentials are deliberately not in this environment.
- Use the \`github_push_branch\` tool to commit and push, and \`github_open_pull_request\` when the work is ready for review.
- Local git is unaffected: \`git status\`, \`git diff\` and \`git log\` all work normally.`
      : '';

    return `You are working on Issue ${issue.identifier}: ${issue.title}

Description:
${issue.description}${planSection}${handoffSection}

Instructions:
1. First analyze relevant files in the workspace.
2. Implement the required changes cleanly and concisely.
3. Run existing tests or add new tests to verify your implementation.
4. Summarize your completed work.${remoteSection}`;
  }

  private async handleProcessExit(
    runId: string,
    cwd: string,
    branchName: string,
    issue: Issue,
    code: number | null,
    signal: string | null,
    terminationReason?: ProcessTerminationReason
  ) {
    // The persona file and any MCP config exist only for the duration of the
    // spawn; leaving them would accumulate a directory per run.
    cleanupRunMcpConfig(runId);

    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

    // Cancellation wins over the child process's eventual exit event. The
    // kill callback can be delivered after the cancellation row was saved,
    // and it must never reopen the review pipeline.
    if (run.status === 'cancelled') return;

    const exitDecision = classifyProcessExit(code, signal, terminationReason);
    if (exitDecision.kind === 'cancelled') return;
    if (exitDecision.kind === 'failed') {
      this.markRunFailed(runId, exitDecision.message);
      return;
    }

    /*
     * Re-derived here rather than carried in from startRun. This method is also
     * where a process that outlived a restart lands, and a run whose access had
     * to be reconstructed from state it no longer holds would fall back to the
     * default — the wrong direction to guess about a permission.
     */
    const runAgent = sqliteService.getAgents().find(a => a.id === run.agentId);
    const access = mcpAccessFor(
      runAgent ? resolveAgentLogged(runAgent).autonomyLevel : undefined,
      'run'
    );

    const now = new Date().toISOString();

    if (exitDecision.kind === 'success') {
      // Transition through remaining stages to review
      this.advanceStage(runId, 'analysis', 'success');
      this.advanceStage(runId, 'implementation', 'success');
      this.advanceStage(runId, 'tests', 'success');
      this.advanceStage(runId, 'review', 'running');

      // Compute real Git diff
      const diffStats = await getGitDiffStats(cwd);

      /**
       * Commit, push, and open a pull request — when there is somewhere to push.
       *
       * This was seeded with `https://github.com/LloydLim1/Alpha-v2/pull/<id>`,
       * a hardcoded link into one person's repository. When PR creation failed,
       * or the project had no remote, the run reported that URL as though a
       * pull request existed — pointing at a stranger's project.
       */
      /**
       * One pull request per issue, not per agent.
       *
       * Each member still commits, which gives a per-agent trail on the shared
       * branch. Opening a PR is the squad's final act, so members before the
       * last commit and stop — otherwise a four-member squad would open four
       * pull requests for the same issue, three of them against unfinished work.
       */
      const squadRun = run.squadRunId ? sqliteService.getSquadRun(run.squadRunId) : undefined;
      const isFinalMember = isFinalSquadMember(run, squadRun);

      let prUrl: string | undefined;
      try {
        const isRepo = await isGitRepo(cwd);
        if (isRepo) {
          const commitMsg = `feat(${issue.identifier.toLowerCase()}): ${issue.title} [${issue.identifier}]`;
          /*
           * A read-only run commits and stops. Filtering the agent's own push
           * tool while the pipeline pushed for it left Supervised meaning
           * nothing: the reviewer's run pushed a branch and opened a duplicate
           * pull request for a change that was already under review.
           */
          const mayPush = access === 'write';
          const committed = await githubService.commitAndPush(cwd, branchName, commitMsg, mayPush);
          let commitNote: string;
          if (!mayPush) {
            commitNote = `Committed to ${branchName}. Not pushed: this agent has read-only remote access.`;
          } else if (committed) {
            commitNote = `Committed and pushed: "${commitMsg}" to ${branchName}`;
          } else {
            commitNote = `Nothing left to commit — the agent had already committed its work. Pushed ${branchName}.`;
          }
          this.appendLog(runId, 'review', commitNote);
          // Recorded whoever did the committing, so the trail shows the push
          // even when the agent made the commits itself.
          sqliteService.recordRemoteAction({
            runId,
            agentId: run.agentId,
            issueId: issue.id,
            actor: 'alpha',
            action: mayPush ? 'push' : 'commit',
            target: branchName,
            detail: commitNote,
            succeeded: true
          });

          const prBody = `## Summary of Changes
Closes ${issue.identifier}: ${issue.title}

### Description
${issue.description}

### Verification Results
- **Changed Files:** ${diffStats.changedFiles}
- **Insertions:** +${diffStats.insertions}
- **Deletions:** -${diffStats.deletions}
- **Tests:** not verified by Alpha — see the run log

---
*Autonomous Pull Request created by Alpha Orchestration Engine.*`;

          if (!isFinalMember) {
            this.appendLog(
              runId,
              'review',
              `Handing over to the next squad member. The pull request opens when the squad finishes.`
            );
          }

          try {
            if (!isFinalMember) throw new SkipPullRequest();
            // Nothing was pushed, so there is no branch on the remote to open
            // a pull request against.
            if (!mayPush) throw new SkipPullRequest();
            const createdPr = await githubService.createPullRequest(
              cwd,
              `feat: ${issue.title} [${issue.identifier}]`,
              prBody,
              'main',
              branchName
            );
            if (createdPr) {
              prUrl = createdPr;
              this.appendLog(runId, 'review', `Created GitHub Pull Request: ${prUrl}`);
              sqliteService.recordRemoteAction({
                runId,
                agentId: run.agentId,
                issueId: issue.id,
                actor: 'alpha',
                action: 'open_pull_request',
                target: prUrl,
                detail: `${branchName} into main`,
                succeeded: true
              });
            }
          } catch (prErr: any) {
            // A skipped pull request is a mid-squad handover, not a failure —
            // recording it as one would put a red line in the trail for a
            // member that did exactly the right thing.
            if (!(prErr instanceof SkipPullRequest)) {
              this.appendLog(runId, 'review', `PR Note: ${prErr.message || prErr}`);
              sqliteService.recordRemoteAction({
                runId,
                agentId: run.agentId,
                issueId: issue.id,
                actor: 'alpha',
                action: 'open_pull_request',
                target: branchName,
                detail: String(prErr?.message ?? prErr),
                succeeded: false
              });
            }
          }
        }
      } catch (gitErr: any) {
        this.appendLog(runId, 'review', `Git automation notice: ${gitErr.message || gitErr}`);
        sqliteService.recordRemoteAction({
          runId,
          agentId: run.agentId,
          issueId: issue.id,
          actor: 'alpha',
          action: 'push',
          target: branchName,
          detail: String(gitErr?.message ?? gitErr),
          succeeded: false
        });
      }

      /**
       * Re-read before composing the final row.
       *
       * `run` was loaded at the top of this method — before four advanceStage
       * calls and before the git commit, push and PR awaits, every one of
       * which writes this row. Spreading the copy from entry restores the
       * stages as they were then, and nulls out any token totals recordUsage
       * wrote while the process was exiting. The `result` event carrying those
       * totals frequently arrives in the same tick as the exit, so this is the
       * normal case, not a race.
       */
      const current = sqliteService.getPrototypeRuns().find(r => r.id === runId) ?? run;

      const updatedStages = current.stages.map(s => ({
        ...s,
        status: 'success' as const,
        completedAt: s.completedAt || now
      }));

      const finalRun: PrototypeRun = {
        ...current,
        status: 'awaiting_approval',
        currentStageIndex: 4,
        stages: updatedStages,
        /**
         * Real numbers, including zero.
         *
         * These read `diffStats.changedFiles || 3`, `|| 45`, `|| 8` — so a run
         * that changed nothing reported three files and forty-five insertions.
         * Measured: an Antigravity run whose tool was auto-denied produced no
         * edits at all and still came back as "3 files, +45/-8, all tests
         * passed", which is indistinguishable from a real success.
         *
         * cliRunner carries a comment about the identical mistake one layer
         * down — a canned string "made a failed spawn look like a successful
         * answer, which is how this went unnoticed". Same pattern, same file
         * tree, fixed once before.
         */
        changedFiles: diffStats.changedFiles,
        insertions: diffStats.insertions,
        deletions: diffStats.deletions,
        /**
         * Alpha does not run the tests, so it cannot report on them.
         *
         * This said "All unit and regression tests passed." unconditionally.
         * The agent is *asked* to run tests in the task prompt, but nothing
         * checks whether it did, or what happened — and the claim was also
         * being written into pull request descriptions.
         */
        testSummary: diffStats.changedFiles
          ? `${diffStats.changedFiles} file(s) changed. Tests were not verified by Alpha — review the run log.`
          : 'No files were changed by this run.',
        prUrl,
        activities: [
          ...(current.activities ?? []),
          this.createActivity(runId, current.activities ?? [], {
            kind: 'summary',
            stageId: 'review',
            message: diffStats.changedFiles
              ? `Run finished: ${diffStats.changedFiles} file(s) changed. Awaiting review.`
              : 'Run finished without changing files. Awaiting review.'
          },
          now)
        ],
        updatedAt: now
      };

      sqliteService.savePrototypeRun(finalRun);

      /**
       * A member finishing is not the squad finishing.
       *
       * `isFinalMember` above already stopped the middle of a squad opening
       * four pull requests for one issue. This line had no such guard, so the
       * first member to finish moved the card to Review while three agents were
       * still committing to the shared branch — the board said the work was
       * ready to look at, and the work had not happened yet.
       *
       * A mid-squad member leaves the card in `agent_running`, which is what it
       * is. squadRunner emits `squad_run_completed` when the last one lands.
       */
      if (isFinalMember) {
        updateIssueAndPush(issue.id, {
          status: 'review',
          prUrl
        });
      }

      if (supabaseService.isConfigured()) {
        supabaseService.saveRunToCloud(finalRun).catch(() => {});
        if (isFinalMember) {
          supabaseService.updateIssueInCloud(issue.id, { status: 'review', prUrl }).catch(() => {});
        }
        supabaseService.broadcastRunEvent(runId, { type: 'run_completed', payload: finalRun }).catch(() => {});
      }

      sqliteService.addIssueComment({
        id: `comm-${runId}-complete`,
        issueId: issue.id,
        authorType: 'agent',
        authorName: 'Alpha Execution Engine',
        content: finalRun.changedFiles
          ? `Run finished. **+${finalRun.insertions}** / **-${finalRun.deletions}** across **${finalRun.changedFiles}** file(s) on \`${branchName}\`.` +
            (prUrl ? ` Pull request: [${prUrl}](${prUrl}).` : ' No pull request was opened.')
          : `Run finished without changing any files. Check the run log — the agent may not have been able to edit the workspace.`,
        createdAt: now
      });

      this.emit('run_completed', finalRun);
    } else {
      this.markRunFailed(runId, `Process exited with error code: ${code}`);
    }
  }

  private advanceStage(runId: string, stageId: StageId, status: 'running' | 'success' | 'failed') {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run || ['cancelled', 'failed', 'awaiting_approval', 'completed', 'changes_requested'].includes(run.status)) return;

    const now = new Date().toISOString();
    const stageIndex = run.stages.findIndex(s => s.id === stageId);
    if (stageIndex === -1) return;

    const updatedStages = run.stages.map((s, idx) => {
      if (idx < stageIndex && s.status === 'running') {
        return { ...s, status: 'success' as const, completedAt: now };
      }
      if (idx === stageIndex) {
        return {
          ...s,
          status,
          startedAt: s.startedAt || now,
          completedAt: status === 'success' || status === 'failed' ? now : undefined
        };
      }
      return s;
    });

    const updatedRun: PrototypeRun = {
      ...run,
      currentStageIndex: stageIndex,
      stages: updatedStages,
      updatedAt: now
    };

    sqliteService.savePrototypeRun(updatedRun);
    const eventPayload = { runId, stageId, status, stageIndex };
    this.emit('stage_update', eventPayload);

    this.appendActivity(runId, {
      kind: 'status',
      stageId,
      message: `${updatedStages[stageIndex]?.label ?? stageId} ${status === 'running' ? 'started' : status}.`
    });

    if (supabaseService.isConfigured()) {
      supabaseService.broadcastRunEvent(runId, { type: 'stage_update', payload: eventPayload }).catch(() => {});
    }
  }

  private appendLog(
    runId: string,
    stageId: StageId,
    message: string,
    activityKind: RunActivityKind = 'status',
    activityOptions: {
      streamKey?: string;
      isStreaming?: boolean;
      detail?: string;
      activityMessage?: string;
    } = {}
  ) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run || ['cancelled', 'failed', 'awaiting_approval', 'completed', 'changes_requested'].includes(run.status)) return;

    const updatedStages = run.stages.map(s => {
      if (s.id === stageId) {
        return { ...s, logs: [...s.logs, message] };
      }
      return s;
    });

    const updatedRun = { ...run, stages: updatedStages, updatedAt: new Date().toISOString() };
    sqliteService.savePrototypeRun(updatedRun);
    const eventPayload = { runId, stageId, message };
    this.emit('log_chunk', eventPayload);

    this.appendActivity(runId, {
      kind: activityKind,
      stageId,
      message: activityOptions.activityMessage ?? message,
      streamKey: activityOptions.streamKey,
      isStreaming: activityOptions.isStreaming,
      detail: activityOptions.detail
    });

    if (supabaseService.isConfigured()) {
      supabaseService.broadcastRunEvent(runId, { type: 'log_chunk', payload: eventPayload }).catch(() => {});
    }
  }

  /**
   * Append or update one safe, user-visible event in the run timeline.
   *
   * Provider deltas use the same stream key and replace the in-progress entry
   * as the text grows. Every other event gets its own sequence number, keeping
   * the feed chronological after a reload as well as during realtime updates.
   */
  private appendActivity(
    runId: string,
    input: {
      kind: RunActivityKind;
      message: string;
      stageId?: StageId;
      streamKey?: string;
      isStreaming?: boolean;
      detail?: string;
      append?: boolean;
    }
  ) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run || ['cancelled', 'failed', 'awaiting_approval', 'completed', 'changes_requested'].includes(run.status)) return;

    const activities = [...(run.activities ?? [])];
    const matchIndex = input.streamKey
      ? activities.map((activity, index) => ({ activity, index }))
          .reverse()
          .find(({ activity }) => activity.streamKey === input.streamKey && activity.isStreaming)?.index
      : undefined;

    let activity: RunActivity;
    if (matchIndex !== undefined) {
      const previous = activities[matchIndex];
      activity = {
        ...previous,
        message: input.append ? `${previous.message}${input.message}` : input.message,
        stageId: input.stageId ?? previous.stageId,
        isStreaming: input.isStreaming ?? false,
        detail: input.detail ?? previous.detail
      };
      activities[matchIndex] = activity;
    } else {
      const sequence = activities.reduce((max, item) => Math.max(max, item.sequence), -1) + 1;
      activity = {
        id: `${runId}:activity:${sequence}`,
        sequence,
        kind: input.kind,
        message: input.message,
        createdAt: new Date().toISOString(),
        stageId: input.stageId,
        streamKey: input.streamKey,
        isStreaming: input.isStreaming,
        detail: input.detail
      };
      activities.push(activity);
    }

    sqliteService.savePrototypeRun({ ...run, activities, updatedAt: new Date().toISOString() });
    const eventPayload = { runId, activity };
    this.emit('run_activity', eventPayload);

    if (supabaseService.isConfigured()) {
      supabaseService.broadcastRunEvent(runId, { type: 'run_activity', payload: eventPayload }).catch(() => {});
    }
  }

  private createActivity(
    runId: string,
    activities: RunActivity[],
    input: Omit<RunActivity, 'id' | 'sequence' | 'createdAt'>,
    createdAt = new Date().toISOString()
  ): RunActivity {
    const sequence = activities.reduce((max, item) => Math.max(max, item.sequence), -1) + 1;
    return {
      ...input,
      id: `${runId}:activity:${sequence}`,
      sequence,
      createdAt
    };
  }

  private describeToolActivity(toolName: string, input: any): string {
    const name = toolName.toLowerCase();
    const file = input?.file_path ?? input?.path ?? input?.filename;
    const command = input?.command ?? input?.CommandLine;
    if (name.includes('edit') || name.includes('write') || name.includes('patch') || name.includes('replace')) {
      return file ? `Edited ${file}` : `Edited files with ${toolName}`;
    }
    if (name.includes('read') || name.includes('view')) {
      return file ? `Read ${file}` : `Viewed files with ${toolName}`;
    }
    if (name.includes('grep') || name.includes('search') || name.includes('glob')) {
      return `Searched the workspace with ${toolName}`;
    }
    if (name.includes('bash') || name.includes('exec') || name.includes('command') || command) {
      return command ? `Ran command: ${String(command).slice(0, 240)}` : `Ran a command with ${toolName}`;
    }
    return `Used ${toolName}`;
  }

  /**
   * A queued run reaching the front of its workspace queue.
   *
   * Only the transition out of `queued` needs announcing: everything after it
   * is already covered by stage updates. Without this the run would sit at
   * `queued` in the UI for its whole life, because nothing else ever writes
   * that field until the run finishes.
   */
  private markRunStarted(runId: string) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run || run.status !== 'queued') return;

    const now = new Date().toISOString();
    const startedRun: PrototypeRun = {
      ...run,
      status: 'running',
      stages: run.stages.map((s, idx) =>
        idx === 0
          ? { ...s, status: 'running' as const, startedAt: s.startedAt || now, logs: [...s.logs, `Checking out branch: ${run.branchName}`] }
          : s
      ),
      activities: [
        ...(run.activities ?? []),
        this.createActivity(runId, run.activities ?? [], {
          kind: 'status',
          stageId: 'workspace',
          message: 'Run started after the workspace became available.'
        }, now)
      ],
      updatedAt: now
    };

    sqliteService.savePrototypeRun(startedRun);
    this.emit('run_started', startedRun);

    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(startedRun).catch(() => {});
    }
  }

  private markRunFailed(runId: string, errorMsg: string) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run || ['cancelled', 'failed', 'awaiting_approval', 'completed', 'changes_requested'].includes(run.status)) return;

    const now = new Date().toISOString();
    const updatedStages = run.stages.map((s, idx) => {
      if (idx === run.currentStageIndex) {
        return { ...s, status: 'failed' as const, completedAt: now, logs: [...s.logs, `Error: ${errorMsg}`] };
      }
      return s;
    });

    const failedRun: PrototypeRun = {
      ...run,
      status: 'failed',
      stages: updatedStages,
      testSummary: `Run failed: ${errorMsg}`,
      activities: [
        ...(run.activities ?? []),
        this.createActivity(runId, run.activities ?? [], {
          kind: 'error',
          stageId: run.stages[run.currentStageIndex]?.id,
          message: `Run failed: ${errorMsg}`
        }, now)
      ],
      updatedAt: now
    };

    sqliteService.savePrototypeRun(failedRun);
    updateIssueAndPush(run.issueId, { status: 'in_progress' });
    this.emit('run_failed', failedRun);

    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(failedRun).catch(() => {});
      supabaseService.updateIssueInCloud(run.issueId, { status: 'in_progress' }).catch(() => {});
      supabaseService.broadcastRunEvent(runId, { type: 'run_failed', payload: failedRun }).catch(() => {});
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new Error(`Run is ${run.status}, not cancellable.`);
    }

    const now = new Date().toISOString();
    const updatedStages = run.stages.map((s, idx) => {
      if (idx === run.currentStageIndex) {
        return { ...s, status: 'cancelled' as const, completedAt: now };
      }
      return s;
    });

    const cancelledRun: PrototypeRun = {
      ...run,
      status: 'cancelled',
      stages: updatedStages,
      activities: [
        ...(run.activities ?? []),
        this.createActivity(runId, run.activities ?? [], {
          kind: 'status',
          stageId: run.stages[run.currentStageIndex]?.id,
          message: 'Run cancelled by the user.'
        }, now)
      ],
      updatedAt: now
    };

    sqliteService.savePrototypeRun(cancelledRun);
    updateIssueAndPush(run.issueId, { status: 'in_progress' });
    this.emit('run_cancelled', cancelledRun);

    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(cancelledRun).catch(() => {});
      supabaseService.updateIssueInCloud(run.issueId, { status: 'in_progress' }).catch(() => {});
      supabaseService.broadcastRunEvent(runId, { type: 'run_cancelled', payload: cancelledRun }).catch(() => {});
    }

    // Persist cancellation before killing the child. If the exit event wins
    // the scheduling race, handleProcessExit now sees the terminal row and
    // cannot finalize it as a success.
    await processManager.killProcess(runId, 'SIGTERM', 'cancelled');
  }
}

export const runnerService = new RunnerService();
