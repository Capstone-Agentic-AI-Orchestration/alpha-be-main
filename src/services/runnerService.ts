import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sqliteService } from './sqliteService.js';
import { processManager } from './processManager.js';
import { StreamParser, RunTelemetry } from './streamParser.js';
import { buildTurnInvocation, writeTurnPersona } from './cliRunner.js';
import { resolveAgentLogged } from './personaService.js';
import { agentReadiness } from './agentReadiness.js';
import { buildEnv } from './customCliArgs.js';
import { mergeUsage, hasUsage } from './runUsage.js';
import { writeRunMcpConfig, cleanupRunMcpConfig } from './mcpConfigService.js';
import { createLineBuffer } from '../utils/lineBuffer.js';
import { createBranch, checkoutBranch, getGitDiffStats, isGitRepo } from '../utils/gitUtils.js';
import { githubService } from './githubService.js';
import { supabaseService } from './supabaseService.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, PrototypeRunStage, StageId, Issue } from '../models/index.js';
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
     * Resolve the working directory from the project's own resources.
     *
     * There is deliberately no fallback. This used to default to
     * `path.resolve('..')` — the directory above the daemon, which is Alpha's
     * own source tree — so a project attached only to a GitHub URL ran its
     * agent inside Alpha itself. Failing loudly is the correct behaviour: a
     * project with nothing checked out has no workspace, and inventing one is
     * how an agent edits the wrong repository.
     *
     * A managed checkout wins over a hand-attached folder. If Alpha cloned or
     * scaffolded the repository, that copy is the one it knows how to refresh.
     */
    const managed = project.resources.find(r => r.type === 'github_repo' && r.localPath);
    const attached = project.resources.find(r => r.type === 'local_path' || r.type === 'local_dir');

    const cwd = managed?.localPath
      ? path.resolve(managed.localPath)
      : attached
        ? path.resolve(attached.pathOrUrl)
        : null;

    if (!cwd) {
      throw new Error(
        `Project "${project.name}" has no working copy. Attach a local folder, or clone one of its repositories, before running an agent.`
      );
    }

    if (!fs.existsSync(cwd)) {
      throw new Error(`Working copy for "${project.name}" is missing from disk: ${cwd}`);
    }

    /**
     * Managed checkouts are already covered — the workspace root is allowlisted
     * once and `isPathAllowed` matches on prefix.
     *
     * A hand-attached folder is registered here because choosing it in the UI
     * is an explicit act of consent. What is gone is registering a *computed*
     * path: that made the gate in processManager unable to refuse anything,
     * since whatever this function invented was allowlisted a line later.
     */
    if (!managed && attached && !sqliteService.isPathAllowed(cwd)) {
      sqliteService.addAllowedPath(cwd, project.name);
    }

    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();
    /**
     * A squad's members all commit to the branch the squad run opened. Only a
     * lone agent gets a fresh one.
     */
    const branchName =
      params.squad?.branchName ??
      `feat/${issue.identifier.toLowerCase()}-${Date.now().toString().slice(-4)}`;

    const stages: PrototypeRunStage[] = [
      { id: 'workspace', label: 'Preparing workspace', description: 'Checking out branch and initializing environment.', status: 'running', logs: [`Target repository: ${cwd}`, `Checking out branch: ${branchName}`], startedAt: now },
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
      status: 'running',
      scenario,
      plan,
      currentStageIndex: 0,
      stages,
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
    sqliteService.updateIssue(issueId, {
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
      content: `Started autonomous execution for **${issue.identifier}** (${issue.title}) on branch \`${branchName}\`.`,
      createdAt: now,
      isThinking: true
    });

    // Execute asynchronously in background
    this.executeTask({
      runId,
      issue,
      agent,
      project,
      cwd,
      branchName,
      plan,
      squad: params.squad
    }).catch(err => {
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

    // 2. Build task prompt with project rules & issue details
    const prompt = this.buildTaskPrompt(issue, plan, ctx.squad?.handoff);

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

    const { env } = buildEnv(agent.envVars);
    const mcp = writeRunMcpConfig(runId, undefined);

    const invocation = buildTurnInvocation(
      {
        runId,
        cwd,
        mode: 'run',
        // Keeps the persona out of argv — see TurnInvocation.stdin.
        personaFile: writeTurnPersona(runId, persona.systemPrompt) ?? undefined,
        provider: persona.modelProvider,
        modelName: persona.modelName,
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
      onExit: async (code) => {
        await this.handleProcessExit(runId, cwd, branchName, issue, code);
      }
    });

    if (child.stdout) {
      createLineBuffer(child.stdout, (line) => {
        const parsedEvents = parser.parseLine(line);
        for (const ev of parsedEvents) {
          if (ev.type === 'stage_transition' && ev.stage) {
            this.advanceStage(runId, ev.stage, 'running');
          } else if (ev.type === 'log' && ev.message) {
            const currentStage = parser.getCurrentStage();
            this.appendLog(runId, currentStage, ev.message);
          } else if (ev.type === 'tool_call' && ev.toolName) {
            const currentStage = parser.getCurrentStage();
            this.appendLog(runId, currentStage, `[Tool Call] ${ev.toolName}: ${JSON.stringify(ev.toolInput || {})}`);
          } else if (ev.type === 'result' && ev.telemetry) {
            this.recordUsage(runId, ev.telemetry);
          }
        }
      });
    }

    if (child.stderr) {
      createLineBuffer(child.stderr, (line) => {
        const currentStage = parser.getCurrentStage();
        this.appendLog(runId, currentStage, `[stderr] ${line}`);
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

  private buildTaskPrompt(issue: Issue, plan: string[], handoff?: string): string {
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

    return `You are working on Issue ${issue.identifier}: ${issue.title}

Description:
${issue.description}${planSection}${handoffSection}

Instructions:
1. First analyze relevant files in the workspace.
2. Implement the required changes cleanly and concisely.
3. Run existing tests or add new tests to verify your implementation.
4. Summarize your completed work.`;
  }

  private async handleProcessExit(runId: string, cwd: string, branchName: string, issue: Issue, code: number | null) {
    // The persona file and any MCP config exist only for the duration of the
    // spawn; leaving them would accumulate a directory per run.
    cleanupRunMcpConfig(runId);

    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

    const now = new Date().toISOString();

    if (code === 0 || code === null) {
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
      const isFinalMember =
        !squadRun || run.squadOrder === squadRun.memberAgentIds.length - 1;

      let prUrl: string | undefined;
      try {
        const isRepo = await isGitRepo(cwd);
        if (isRepo) {
          const commitMsg = `feat(${issue.identifier.toLowerCase()}): ${issue.title} [${issue.identifier}]`;
          await githubService.commitAndPush(cwd, branchName, commitMsg);
          this.appendLog(runId, 'review', `Committed and pushed: "${commitMsg}" to ${branchName}`);

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
            }
          } catch (prErr: any) {
            if (!(prErr instanceof SkipPullRequest)) {
              this.appendLog(runId, 'review', `PR Note: ${prErr.message || prErr}`);
            }
          }
        }
      } catch (gitErr: any) {
        this.appendLog(runId, 'review', `Git automation notice: ${gitErr.message || gitErr}`);
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
        updatedAt: now
      };

      sqliteService.savePrototypeRun(finalRun);
      sqliteService.updateIssue(issue.id, {
        status: 'review',
        prUrl
      });

      if (supabaseService.isConfigured()) {
        supabaseService.saveRunToCloud(finalRun).catch(() => {});
        supabaseService.updateIssueInCloud(issue.id, { status: 'review', prUrl }).catch(() => {});
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
    if (!run) return;

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

    if (supabaseService.isConfigured()) {
      supabaseService.broadcastRunEvent(runId, { type: 'stage_update', payload: eventPayload }).catch(() => {});
    }
  }

  private appendLog(runId: string, stageId: StageId, message: string) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

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

    if (supabaseService.isConfigured()) {
      supabaseService.broadcastRunEvent(runId, { type: 'log_chunk', payload: eventPayload }).catch(() => {});
    }
  }

  private markRunFailed(runId: string, errorMsg: string) {
    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

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
      updatedAt: now
    };

    sqliteService.savePrototypeRun(failedRun);
    sqliteService.updateIssue(run.issueId, { status: 'in_progress' });
    this.emit('run_failed', failedRun);

    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(failedRun).catch(() => {});
      supabaseService.updateIssueInCloud(run.issueId, { status: 'in_progress' }).catch(() => {});
      supabaseService.broadcastRunEvent(runId, { type: 'run_failed', payload: failedRun }).catch(() => {});
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await processManager.killProcess(runId, 'SIGTERM');

    const run = sqliteService.getPrototypeRuns().find(r => r.id === runId);
    if (!run) return;

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
      updatedAt: now
    };

    sqliteService.savePrototypeRun(cancelledRun);
    sqliteService.updateIssue(run.issueId, { status: 'in_progress' });
    this.emit('run_cancelled', cancelledRun);

    if (supabaseService.isConfigured()) {
      supabaseService.saveRunToCloud(cancelledRun).catch(() => {});
      supabaseService.updateIssueInCloud(run.issueId, { status: 'in_progress' }).catch(() => {});
      supabaseService.broadcastRunEvent(runId, { type: 'run_cancelled', payload: cancelledRun }).catch(() => {});
    }
  }
}

export const runnerService = new RunnerService();
