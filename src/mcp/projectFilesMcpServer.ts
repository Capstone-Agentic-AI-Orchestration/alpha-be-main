/**
 * Alpha's project files tools, as a stdio MCP server.
 *
 * Gives a chat turn read-only access to the selected project's repositories
 * on this computer, and nothing else. The folders arrive in
 * ALPHA_PROJECT_ROOTS from the per-turn config mcpConfigService writes; every
 * path is checked against them in projectFiles. See that module for why the
 * agent CLI's own file tools are not used for this.
 *
 * Entry point only -- nothing imports this.
 */
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { isImplementationTask } from '../services/agentRoleContracts.js';
import { recordPlannerRead } from '../services/plannerReads.js';
import { auditTaskDependencies, taskCanAudit, deleteTaskFile, editTaskFile, generateTaskLockfile, parseTaskFileScope, runTaskCheck, stopTaskOperations, writeTaskFile, type TaskFileScope } from '../services/taskFileAccess.js';
import { normalizeAndValidateAgentReport } from '../services/orchestrationAgentReport.js';
import { TaskCheckGate } from '../services/taskCheckGate.js';

import {
  listFiles,
  listRepositories,
  parseRoots,
  readFile,
  resolveInProject,
  runGit,
  searchFiles
} from '../services/projectFiles.js';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

const ROOTS = parseRoots(process.env.ALPHA_PROJECT_ROOTS);
const TASK = parseTaskFileScope(process.env.ALPHA_TASK_SCOPE);
/**
 * Where to record each file this turn opens, set only for a planning turn (see plannerReads).
 * Created at startup, so an empty log still shows the planner had these tools.
 */
const READ_LOG = process.env.ALPHA_READ_LOG?.trim() || null;
if (READ_LOG) fs.appendFileSync(READ_LOG, '');

/** Checks run before handing in; see TaskCheckGate. Only for tasks that edit files and may run checks. */
const CHECK_GATE = TASK && !TASK.reportOnly && isImplementationTask(TASK.kind) && TASK.requiredChecks.length
  ? new TaskCheckGate(TASK.requiredChecks)
  : null;
/** A file tool that changed the files: the checks must run again before handing in. */
const changing = <T,>(run: () => T): T => {
  const value = run();
  if (value instanceof Promise) return value.then(result => { CHECK_GATE?.recordChange(); return result; }) as T;
  CHECK_GATE?.recordChange();
  return value;
};

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => unknown | Promise<unknown>;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
const repository = str('Repository folder name or owner/repo. Optional when the project has one repository on this computer.');

const TOOLS: Record<string, ToolDef> = {
  project_list_repositories: {
    description: 'List the project repositories on this computer that you can read, with their folders.',
    inputSchema: schema({}),
    run: () => listRepositories(ROOTS)
  },
  project_list_files: {
    description: 'List files and folders in one of the project repositories. Dependencies and build output are named but not listed.',
    inputSchema: schema({
      repository,
      path: str('Folder inside the repository, relative to it. Empty for the top level.'),
      depth: int('How many levels to list, 1 to 4. Default 2.')
    }),
    run: args => listFiles(ROOTS, args)
  },
  project_read_file: {
    description: 'Read a text file in one of the project repositories, with line numbers. Secret files such as .env are not shown.',
    inputSchema: schema({
      repository,
      path: str('File path, relative to the repository or absolute inside it.'),
      start_line: int('First line to show. Default 1.'),
      max_lines: int('How many lines, up to 2000. Default 400.')
    }, ['path']),
    run: args => {
      const content = readFile(ROOTS, args);
      if (READ_LOG) {
        const target = resolveInProject(ROOTS, args.repository, args.path);
        recordPlannerRead(READ_LOG, { repository: target.root.repo, path: target.rel });
      }
      return content;
    }
  },
  project_search: {
    description: 'Search the text of the project repositories. Returns file:line: text for each match.',
    inputSchema: schema({
      query: str('Text to find, or a regular expression when regex is true.'),
      repository: str('Limit to one repository. Default: all of them.'),
      path: str('Limit to a folder or file inside the repository.'),
      regex: bool('Treat query as a regular expression.'),
      case_sensitive: bool('Match case. Default false.'),
      max_results: int('Up to 300. Default 100.')
    }, ['query']),
    run: args => searchFiles(ROOTS, args)
  },
  project_git: {
    description: 'Read git state of a project repository: status, log, diff (working tree, or against a ref), or branches. Read only.',
    inputSchema: schema({
      repository,
      command: str('status, log, diff or branches.', { enum: ['status', 'log', 'diff', 'branches'] }),
      ref: str('For log and diff: a branch, tag, commit or range such as main...HEAD.'),
      path: str('Limit to a file or folder inside the repository.'),
      max_count: int('For log: how many commits, up to 50. Default 20.')
    }, ['command']),
    run: args => runGit(ROOTS, args)
  }
};

if (TASK) {
  if (TASK.reportOnly) for (const name of Object.keys(TOOLS)) delete TOOLS[name];
  if (taskCanAudit(TASK)) TOOLS.project_audit_dependencies = {
    description: 'Run the assigned npm vulnerability audit read-only in a disposable metadata copy. Returns immutable audit evidence, findings, policy result or scanner error. Never updates product files. Include the returned evidence id in auditEvidenceIds in your report.',
    inputSchema: schema({}), run: () => auditTaskDependencies(ROOTS, TASK)
  };
  if (!TASK.reportOnly && isImplementationTask(TASK.kind)) {
    TOOLS.project_write_file = {
      description: 'Create a source file inside this task’s approved path scope. To replace an existing file, include its current content as expected_content (as project_read_file shows it, without line numbers; line endings and a byte-order mark do not matter, and the file keeps its own). For small changes prefer project_edit_file.',
      inputSchema: schema({ path: str('Repository-relative path with forward slashes.'), content: str('Full UTF-8 content.'), expected_content: str('Current content when replacing an existing file; line endings do not matter.') }, ['path', 'content']),
      run: args => changing(() => writeTaskFile(ROOTS, TASK, args as any))
    };
    TOOLS.project_edit_file = {
      description: 'Replace exactly one occurrence of old_text in an approved file. Copy old_text from project_read_file without the line numbers; line endings do not matter and the file keeps its own. Refuses text that matches zero or several times, and out-of-scope paths.',
      inputSchema: schema({ path: str('Repository-relative path with forward slashes.'), old_text: str('Nonempty text matching exactly once (line endings ignored).'), new_text: str('Replacement text.') }, ['path', 'old_text', 'new_text']),
      run: args => changing(() => editTaskFile(ROOTS, TASK, args as any))
    };
    TOOLS.project_delete_file = {
      description: 'Delete an approved source file only when its current content matches expected_content (line endings do not matter).',
      inputSchema: schema({ path: str('Repository-relative path with forward slashes.'), expected_content: str('Current file content; line endings do not matter.') }, ['path', 'expected_content']),
      run: args => changing(() => deleteTaskFile(ROOTS, TASK, args as any))
    };
    TOOLS.project_generate_lockfile = {
      description: 'Generate package-lock.json for an npm project with lifecycle scripts disabled in a disposable folder. Requires package-lock.json in the assigned write scope.',
      inputSchema: schema({}), run: () => changing(() => generateTaskLockfile(ROOTS, TASK))
    };
  }
  if (!TASK.reportOnly && (TASK.kind === 'validation' || isImplementationTask(TASK.kind))) {
    TOOLS.project_run_check = {
      description: 'Run task-authorized repository checks in one disposable source copy (dependencies installed once); return exact results without changing project files. Run every assigned check before project_submit_work.',
      inputSchema: schema({
        scripts: { type: 'array', items: { type: 'string' }, description: 'requiredChecks names from this task, e.g. ["test","typecheck","lint"].' },
        script: str('One requiredChecks name (use scripts for several).')
      }),
      run: async args => {
        let scripts: string[] = [];
        if (Array.isArray(args.scripts) && args.scripts.length) scripts = args.scripts.map(String);
        else if (typeof args.script === 'string') scripts = [args.script];
        if (!scripts.length) throw new Error('Name the checks to run in scripts.');
        try {
          return await runTaskCheck(ROOTS, TASK, scripts);
        } finally {
          // Ran, whatever the result: a failure the agent cannot fix must not trap it.
          CHECK_GATE?.recordRun(scripts);
        }
      }
    };
  }
}

if (TASK?.reportFile) {
  const reportFile = TASK.reportFile;
  const task = TASK;
  TOOLS.project_submit_work = {
    description: 'Hand in your finished task to Alpha. Call it once at the end with report set to the task report described in your instructions. If something is missing it says what, so fix that and call it again. After it accepts, finish with one or two plain sentences about what you did.',
    inputSchema: schema({ report: { type: 'object', description: 'The task report, with the fields shown in your task instructions.' } }, ['report']),
    run: args => submitWork(task, reportFile, args)
  };
}

/**
 * A specialist handing in its work: the task report, checked as it arrives. A report Alpha cannot
 * accept comes back as a tool error that says what to fix, so the agent fixes it in the same turn
 * instead of a separate correction run. An accepted report is saved for the build to read.
 */
function submitWork(task: TaskFileScope, reportFile: string, args: Record<string, unknown>): string {
  let report: unknown = args.report;
  // Some models send the object as a JSON string.
  if (typeof report === 'string') {
    try { report = JSON.parse(report); } catch { report = undefined; }
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('report must be an object with the fields from your task instructions.');
  }
  const filled = { schemaVersion: task.reportSchemaVersion, taskId: task.taskId, ...(report as Record<string, unknown>) };
  if (filled.taskId !== task.taskId) throw new Error('taskId must be ' + task.taskId + '.');
  const unchecked = CHECK_GATE?.refusal();
  if (unchecked) throw new Error(unchecked);
  const checked = normalizeAndValidateAgentReport(filled, task.reportSchemaVersion);
  if (!checked.success) throw new Error('Not accepted yet: ' + checked.error + ' Fix that and call project_submit_work again.');
  fs.writeFileSync(reportFile, JSON.stringify(checked.report));
  return 'Received. Alpha will check the work now. Finish with one or two plain sentences about what you did.';
}

type Id = string | number | null;

/** stdout is the transport; anything logged goes to stderr. */
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;
console.debug = console.log;

function send(message: Record<string, unknown>): void {
  realWrite(JSON.stringify(message) + '\n');
}
const reply = (id: Id, result: unknown) => send({ jsonrpc: '2.0', id, result });
const replyError = (id: Id, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
const toolResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'alpha-project-files', version: '1.0.0' }
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !['project_write_file', 'project_edit_file', 'project_delete_file', 'project_generate_lockfile'].includes(name), destructiveHint: name === 'project_delete_file', openWorldHint: ['project_generate_lockfile', 'project_run_check', 'project_audit_dependencies'].includes(name) }
        }))
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return reply(id, toolResult('Unknown tool: ' + name, true));
      try {
        const value = await tool.run(params?.arguments ?? {});
        return reply(id, toolResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      } catch (err: any) {
        return reply(id, toolResult(err?.message ?? String(err), true));
      }
    }
    default:
      return replyError(id, -32601, 'Method not found: ' + method);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return replyError(null, -32700, 'Parse error');
  }
  handle(msg).catch(err => replyError(msg?.id ?? null, -32603, err?.message ?? String(err)));
});
rl.on('close', () => { void stopTaskOperations().finally(() => process.exit(0)); });

