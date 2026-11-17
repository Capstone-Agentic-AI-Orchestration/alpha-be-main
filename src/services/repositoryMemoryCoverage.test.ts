import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every agent that works on a project must read its repository memory first.
 *
 * Prompts are built in several places, and a new one is easy to add without
 * thinking about memory. This test lists every file that builds an agent prompt
 * (or resolves a persona) and how many such calls it makes. A new file, or a new
 * call in a listed file, fails here until someone records whether it passes
 * repository memory and, if not, why. That decision is the point: it cannot be
 * skipped by accident.
 */
const PROMPT_CALL = /\b(resolveAgent|resolveAgentLogged|runCliTurn|plannerSystemPrompt)\(/g;
const PASSES_MEMORY = /\b(projectMemoryBlock|renderProjectMemory|repositoryMemory)\b/;

const SITES: Record<string, { calls: number; memory: boolean; why: string }> = {
  'services/chatService.ts': { calls: 9, memory: true, why: 'Named-agent and default-assistant chat turns get memory; the other calls read roles or run fixed utility turns (prompt improver).' },
  'services/agentCallService.ts': { calls: 2, memory: true, why: 'Independent agent calls on a project.' },
  'services/featureSpecService.ts': { calls: 2, memory: true, why: 'Manager feature-spec turns for a project.' },
  'services/runnerService.ts': { calls: 2, memory: true, why: 'Build tasks (from the task package) and every other run on a project.' },
  'services/orchestrationPlanner.ts': { calls: 2, memory: true, why: 'Defines and uses plannerSystemPrompt, which opens with memory.' },
  'services/projectBuildOrchestrator.ts': { calls: 1, memory: true, why: 'Initial planning, memory read at the planning checkpoints.' },
  'services/orchestrationMilestonePlanner.ts': { calls: 1, memory: true, why: 'Milestone planning, memory read at the accepted checkpoints.' },
  'services/boardPlanRevision.ts': { calls: 1, memory: true, why: 'Plan revision, memory read at the planning checkpoints.' },
  'services/personaService.ts': { calls: 3, memory: true, why: 'Defines resolveAgent, which places repositoryMemory first.' },
  'services/cliRunner.ts': { calls: 1, memory: false, why: 'Defines runCliTurn; callers supply the prompt.' },
  'services/chatBuildIntent.ts': { calls: 2, memory: false, why: 'Classifies whether a message asks for a build: a fixed utility prompt, and a role lookup.' },
  'services/agentBuilderService.ts': { calls: 1, memory: false, why: 'Drafts an agent definition: a fixed utility prompt with no project.' },
  'services/githubRepoArchitecture.ts': { calls: 1, memory: false, why: 'Summarises sampled source into a diagram: a fixed utility prompt over the code itself.' },
  'services/squadRunner.ts': { calls: 2, memory: false, why: 'Role and settings lookups; the squad member runs go through runnerService.' },
  'services/sqliteService.ts': { calls: 1, memory: false, why: 'Only a comment that mentions chatService.resolveAgent(); no prompt is built here.' },
  'controllers/agentCallController.ts': { calls: 2, memory: false, why: 'Role and readiness lookups; the call itself runs in agentCallService.' },
  'controllers/dataController.ts': { calls: 1, memory: false, why: 'Agent settings shown in the app, no prompt.' }
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('repository memory coverage', () => {
  const root = path.resolve(__dirname, '..');
  const found = new Map<string, { calls: number; text: string }>();
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const calls = text.match(PROMPT_CALL)?.length ?? 0;
    if (calls) found.set(path.relative(root, file).split(path.sep).join('/'), { calls, text });
  }

  it('knows every place an agent prompt is built, and how many calls each makes', () => {
    const unknown = [...found].filter(([file, site]) => SITES[file]?.calls !== site.calls)
      .map(([file, site]) => `${file}: ${site.calls} call(s), listed ${SITES[file]?.calls ?? 'nowhere'}. Decide whether it passes repository memory, then record it in SITES.`);
    expect(unknown).toEqual([]);
    expect(Object.keys(SITES).filter(file => !found.has(file))).toEqual([]);
  });

  it('passes repository memory wherever SITES says it does', () => {
    const missing = Object.entries(SITES).filter(([file, site]) => site.memory && !PASSES_MEMORY.test(found.get(file)?.text ?? ''))
      .map(([file]) => file);
    expect(missing).toEqual([]);
  });
});
