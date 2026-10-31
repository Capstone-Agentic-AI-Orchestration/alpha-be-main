import { randomUUID } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { IS_CLOUD } from '../config/env.js';
import { database } from '../store/database.js';
import { projectStore, runStore } from '../store/stores.js';
import { route } from './asyncRoute.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { relayToCloud } from './cloudRelay.js';
import { ticketSlaMetric, type TicketSlaStateEvent } from '../services/operationsSla.js';
import { availabilityPercentFromCounts } from '../services/operationsLogic.js';

export const operationsRouter = Router();
const priorities = new Set(['urgent', 'high', 'medium', 'low', 'none']);
const recurrences = new Set(['one_off', 'monthly', 'annual']);

function unavailable(res: Response): void {
  res.status(503).json({ error: 'The Operations Center requires the Alpha cloud.' });
}

function asIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

operationsRouter.get('/operations', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.read')) return;
  if (!IS_CLOUD) {
    if (await relayToCloud(req, res)) return;
    return unavailable(res);
  }
  const workspaceId = req.workspace!.workspaceId;
  const userId = req.workspace!.userId;
  const sql = database();
  const [projects, runs, deployments, targets, policies, settings, expenses, budgets, notices, ticketRows, ticketEvents] = await Promise.all([
    projectStore().list(workspaceId),
    runStore().listSummaries(workspaceId),
    sql.query<any>(`select d.*, p.name as project_name from alpha_private.ops_deployments d
      join public.projects p on p.workspace_id=d.workspace_id and p.id=d.project_id
      where d.workspace_id=$1 order by d.started_at desc limit 250`, [workspaceId]),
    sql.query<any>(`select t.*, p.name as project_name,
        (select max(checked_at) from alpha_private.ops_probe_samples s where s.target_id=t.id and s.workspace_id=t.workspace_id) as last_checked_at,
        (select min(checked_at) from alpha_private.ops_probe_samples s where s.target_id=t.id and s.workspace_id=t.workspace_id) as coverage_start,
        (select count(*) from alpha_private.ops_probe_samples s where s.target_id=t.id and s.workspace_id=t.workspace_id and s.checked_at >= now()-interval '30 days') as sample_count,
        (select count(*) from alpha_private.ops_probe_samples s where s.target_id=t.id and s.workspace_id=t.workspace_id and s.checked_at >= now()-interval '30 days' and s.ok) as success_count,
        (select jsonb_agg(jsonb_build_object('checkedAt', q.checked_at, 'ok', q.ok, 'latencyMs', q.latency_ms) order by q.checked_at)
         from (select checked_at, ok, latency_ms from alpha_private.ops_probe_samples s where s.target_id=t.id and s.workspace_id=t.workspace_id order by checked_at desc limit 48) q) as recent_samples
      from alpha_private.ops_monitored_targets t join public.projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
      where t.workspace_id=$1 and t.enabled order by p.name, t.environment, t.kind`, [workspaceId]),
    sql.query<any>(`select priority,response_minutes,resolution_minutes,updated_by,updated_at from alpha_private.ops_ticket_sla_policies where workspace_id=$1`, [workspaceId]),
    sql.query<any>(`select production_availability_target,last_deployment_import_at from alpha_private.ops_workspace_settings where workspace_id=$1`, [workspaceId]),
    sql.query<any>(`select e.*,p.name as project_name from alpha_private.ops_project_expenses e
      join public.projects p on p.workspace_id=e.workspace_id and p.id=e.project_id where e.workspace_id=$1 order by e.effective_at desc,e.created_at desc`, [workspaceId]),
    sql.query<any>(`select project_id,amount_usd from alpha_private.ops_project_budgets where workspace_id=$1`, [workspaceId]),
    sql.query<any>(`select id,event_type,title,message,created_at,read_at,archived_at,incident_id from alpha_private.ops_notifications
      where workspace_id=$1 and user_id=$2 order by created_at desc limit 100`, [workspaceId, userId]),
    sql.query<any>(`select t.id,t.reference,t.title,t.status,t.priority,t.created_at,t.closed_at,
        coalesce(r.submitted_at,t.created_at) as started_at,
        (select min(m.created_at) from alpha_private.ticket_messages m where m.workspace_id=t.workspace_id and m.ticket_id=t.id and m.author_kind='pm' and m.audience='client') as first_response_at
      from alpha_private.tickets t left join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
      where t.workspace_id=$1 and t.status not in ('declined','cancelled') order by t.created_at desc limit 500`, [workspaceId]),
    sql.query<any>(`select ticket_id,status,action_owner,occurred_at from alpha_private.ops_ticket_sla_events where workspace_id=$1 order by ticket_id,occurred_at,id`, [workspaceId])
  ]);

  const ticketEventsById = new Map<string, TicketSlaStateEvent[]>();
  for (const row of ticketEvents.rows) {
    const events = ticketEventsById.get(row.ticket_id) ?? [];
    events.push({ status: row.status, actionOwner: row.action_owner, occurredAt: row.occurred_at });
    ticketEventsById.set(row.ticket_id, events);
  }
  const policyByPriority = new Map(policies.rows.map(row => [row.priority, row]));
  const tickets = ticketRows.rows.map(row => {
    const policy = policyByPriority.get(row.priority);
    const events = ticketEventsById.get(row.id) ?? [];
    return {
      id: row.id, reference: row.reference, title: row.title, status: row.status, priority: row.priority,
      startedAt: asIso(row.started_at), firstResponseAt: asIso(row.first_response_at), closedAt: asIso(row.closed_at),
      response: ticketSlaMetric({ startAt: row.started_at, stoppedAt: row.first_response_at, targetMinutes: policy?.response_minutes, events }),
      resolution: ticketSlaMetric({ startAt: row.started_at, stoppedAt: row.closed_at, targetMinutes: policy?.resolution_minutes, events })
    };
  });

  const expenseRows = expenses.rows.map(row => ({
    id: row.id, projectId: row.project_id, projectName: row.project_name, description: row.description,
    vendor: row.vendor, category: row.category, amountUsd: Number(row.amount_usd), recurrence: row.recurrence,
    effectiveAt: String(row.effective_at).slice(0, 10), endsAt: row.ends_at ? String(row.ends_at).slice(0, 10) : null,
    createdBy: row.created_by, createdAt: asIso(row.created_at)
  }));
  const budgetByProject = new Map(budgets.rows.map(row => [row.project_id, Number(row.amount_usd)]));
  const projectCosts = projects.map(project => {
    const projectExpenses = expenseRows.filter(expense => expense.projectId === project.id);
    const manualExpenseUsd = projectExpenses.reduce((sum, expense) => sum + expenseTotalToDate(expense), 0);
    const projectRuns = runs.filter(run => run.projectId === project.id);
    const reportedRunCosts = projectRuns.map(run => run.usage?.costUsd).filter((amount): amount is number => typeof amount === 'number' && Number.isFinite(amount));
    const aiRunCostUsd = reportedRunCosts.length ? roundUsd(reportedRunCosts.reduce((sum, amount) => sum + amount, 0)) : null;
    return {
      projectId: project.id, projectName: project.name, status: project.status,
      aiRunCostUsd, reportedRunCount: reportedRunCosts.length,
      unreportedRunCount: projectRuns.length - reportedRunCosts.length,
      manualExpenseUsd: roundUsd(manualExpenseUsd), totalKnownUsd: roundUsd(manualExpenseUsd + (aiRunCostUsd ?? 0)),
      budgetUsd: budgetByProject.get(project.id) ?? null,
      expenses: projectExpenses,
      targetDate: project.targetDate || null, completedAt: project.completedAt ?? null,
      targetPerformance: deadlineState(project.targetDate, project.completedAt ?? null)
    };
  });
  const milestones = projects.flatMap(project => (project.milestones ?? []).map(milestone => ({
    projectId: project.id, projectName: project.name, ...milestone,
    targetPerformance: deadlineState(milestone.targetDate, milestone.completedAt ?? null)
  })));
  const probeTargets = targets.rows.map(row => {
    const count = Number(row.sample_count);
    return {
      id: row.id, projectId: row.project_id, projectName: row.project_name, repository: row.repository,
      environment: row.environment, kind: row.kind, provider: row.provider, url: row.url, checkPath: row.check_path,
      targetPercent: row.availability_target == null ? null : Number(row.availability_target),
      lastCheckedAt: asIso(row.last_checked_at), coverageStart: asIso(row.coverage_start),
      samples30d: count, uptimePercent30d: availabilityPercentFromCounts(Number(row.success_count), count),
      recentSamples: row.recent_samples ?? []
    };
  });
  const incidents = await sql.query<any>(`select i.id,i.started_at,i.resolved_at,i.last_error,t.project_id,p.name as project_name,t.repository,t.environment,t.kind,t.url
    from alpha_private.ops_incidents i join alpha_private.ops_monitored_targets t on t.id=i.target_id and t.workspace_id=i.workspace_id
    join public.projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
    where i.workspace_id=$1 and i.started_at >= now()-interval '90 days' order by i.started_at desc limit 250`, [workspaceId]);
  const openIncidentCount = incidents.rows.filter(row => !row.resolved_at).length;
  const observedAvailability = probeTargets.filter(target => target.uptimePercent30d !== null && target.environment === 'production');
  const snapshot = {
    generatedAt: new Date().toISOString(),
    summary: {
      activeProjects: projects.filter(project => project.status === 'in_progress').length,
      deployments24h: deployments.rows.filter(row => Date.parse(row.started_at) >= Date.now() - 86_400_000).length,
      openIncidents: openIncidentCount,
      monitoredTargets: probeTargets.length,
      productionUptimePercent30d: observedAvailability.length
        ? roundPercent(observedAvailability.reduce((sum, target) => sum + (target.uptimePercent30d ?? 0), 0) / observedAvailability.length)
        : null,
      productionTargetPercent: Number(settings.rows[0]?.production_availability_target ?? 99.9)
    },
    projects: projectCosts,
    milestones,
    deployments: deployments.rows.map(row => ({
      id: row.id, projectId: row.project_id, projectName: row.project_name, repository: row.repository,
      provider: row.provider, providerDeploymentId: row.provider_deployment_id, environment: row.environment,
      status: row.status, branch: row.branch, commitSha: row.commit_sha, commitMessage: row.commit_message,
      url: row.deployment_url, createdBy: row.created_by, startedAt: asIso(row.started_at), finishedAt: asIso(row.finished_at)
    })),
    targets: probeTargets,
    incidents: incidents.rows.map(row => ({
      id: row.id, projectId: row.project_id, projectName: row.project_name, repository: row.repository,
      environment: row.environment, kind: row.kind, url: row.url, startedAt: asIso(row.started_at),
      resolvedAt: asIso(row.resolved_at), lastError: row.last_error
    })),
    ticketPolicies: policies.rows.map(row => ({
      priority: row.priority, responseMinutes: Number(row.response_minutes), resolutionMinutes: Number(row.resolution_minutes),
      updatedBy: row.updated_by, updatedAt: asIso(row.updated_at)
    })),
    ticketSlaConfigured: policies.rows.length > 0,
    tickets,
    expenses: expenseRows,
    notifications: notices.rows.map(row => ({
      id: row.id, type: 'ops_incident', title: row.title, message: row.message,
      read: Boolean(row.read_at), archived: Boolean(row.archived_at), timestamp: asIso(row.created_at) ?? new Date().toISOString(), entityType: 'ops_incident', entityId: row.incident_id,
      eventType: row.event_type
    })),
    lastDeploymentImportAt: asIso(settings.rows[0]?.last_deployment_import_at)
  };
  res.json(snapshot);
}));

operationsRouter.get('/operations/notifications', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.read')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const result = await database().query<any>(`select id,event_type,title,message,created_at,read_at,archived_at,incident_id
    from alpha_private.ops_notifications where workspace_id=$1 and user_id=$2 order by created_at desc limit 100`,
  [req.workspace!.workspaceId, req.workspace!.userId]);
  res.json(result.rows.map(row => ({ id: row.id, type: 'ops_incident', title: row.title, message: row.message,
    read: Boolean(row.read_at), archived: Boolean(row.archived_at), timestamp: asIso(row.created_at) ?? new Date().toISOString(), entityType: 'ops_incident', entityId: row.incident_id,
    eventType: row.event_type })));
}));

operationsRouter.patch('/operations/uptime-target', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const target = Number(req.body?.targetPercent);
  if (!Number.isFinite(target) || target < 90 || target > 100) return res.status(400).json({ error: 'Set the production target between 90% and 100%.' });
  const workspaceId = req.workspace!.workspaceId;
  await database().query(`insert into alpha_private.ops_workspace_settings(workspace_id,production_availability_target)
    values($1,$2) on conflict(workspace_id) do update set production_availability_target=excluded.production_availability_target,updated_at=now()`, [workspaceId, target]);
  await database().query(`update alpha_private.ops_monitored_targets set availability_target=$2,updated_at=now()
    where workspace_id=$1 and environment='production'`, [workspaceId, target]);
  res.json({ targetPercent: target });
}));

operationsRouter.put('/operations/ticket-policies', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  if (!Array.isArray(req.body?.policies)) return res.status(400).json({ error: 'Policies must be an array.' });
  const removePriorities: unknown[] = Array.isArray(req.body?.removePriorities) ? req.body.removePriorities : [];
  if (removePriorities.some(priority => !priorities.has(priority as string))) return res.status(400).json({ error: 'Unknown ticket priority.' });
  const workspaceId = req.workspace!.workspaceId;
  const updatedBy = req.workspace!.userId;
  for (const policy of req.body.policies) {
    const response = Number(policy.responseMinutes);
    const resolution = Number(policy.resolutionMinutes);
    if (!priorities.has(policy.priority) || !Number.isInteger(response) || !Number.isInteger(resolution)
      || response < 1 || response > 525600 || resolution < 1 || resolution > 525600) {
      return res.status(400).json({ error: 'Each priority needs response and resolution targets from 1 to 525600 minutes.' });
    }
  }
  await database().transaction(async tx => {
    if (removePriorities.length) await tx.query(`delete from alpha_private.ops_ticket_sla_policies where workspace_id=$1 and priority=any($2::text[])`,
      [workspaceId, removePriorities]);
    for (const policy of req.body.policies) {
      await tx.query(`insert into alpha_private.ops_ticket_sla_policies(workspace_id,priority,response_minutes,resolution_minutes,updated_by)
        values($1,$2,$3,$4,$5) on conflict(workspace_id,priority) do update set
          response_minutes=excluded.response_minutes,resolution_minutes=excluded.resolution_minutes,updated_by=excluded.updated_by,updated_at=now()`,
      [workspaceId, policy.priority, Number(policy.responseMinutes), Number(policy.resolutionMinutes), updatedBy]);
    }
  });
  res.json({ success: true });
}));

operationsRouter.delete('/operations/ticket-policies/:priority', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  if (!priorities.has(req.params.priority)) return res.status(400).json({ error: 'Unknown ticket priority.' });
  await database().query('delete from alpha_private.ops_ticket_sla_policies where workspace_id=$1 and priority=$2',
    [req.workspace!.workspaceId, req.params.priority]);
  res.json({ success: true });
}));

operationsRouter.patch('/operations/tickets/:ticketId/priority', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const priority = req.body?.priority;
  if (!priorities.has(priority)) return res.status(400).json({ error: 'Choose a valid ticket priority.' });
  const updated = await database().query(`update alpha_private.tickets set priority=$3 where workspace_id=$1 and id=$2 returning id`,
    [req.workspace!.workspaceId, req.params.ticketId, priority]);
  if (!updated.rows.length) return res.status(404).json({ error: 'Ticket not found in the active workspace.' });
  res.json({ success: true });
}));

operationsRouter.put('/operations/projects/:projectId/budget', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const workspaceId = req.workspace!.workspaceId;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const amount = req.body?.amountUsd;
  if (amount === null || amount === '') {
    await database().query('delete from alpha_private.ops_project_budgets where workspace_id=$1 and project_id=$2', [workspaceId, project.id]);
    return res.json({ budgetUsd: null });
  }
  const amountUsd = Number(amount);
  if (!Number.isFinite(amountUsd) || amountUsd < 0 || amountUsd > 99_999_999_999.99) return res.status(400).json({ error: 'Enter a non-negative USD budget.' });
  await database().query(`insert into alpha_private.ops_project_budgets(workspace_id,project_id,amount_usd,updated_by)
    values($1,$2,$3,$4) on conflict(workspace_id,project_id) do update set amount_usd=excluded.amount_usd,updated_by=excluded.updated_by,updated_at=now()`,
  [workspaceId, project.id, roundUsd(amountUsd), req.workspace!.userId]);
  res.json({ budgetUsd: roundUsd(amountUsd) });
}));

operationsRouter.post('/operations/projects/:projectId/expenses', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const workspaceId = req.workspace!.workspaceId;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const { description, vendor, category, recurrence, effectiveAt, endsAt } = req.body ?? {};
  const amountUsd = Number(req.body?.amountUsd);
  if (typeof description !== 'string' || !description.trim() || description.length > 240
    || typeof category !== 'string' || !category.trim() || category.length > 80
    || (vendor != null && (typeof vendor !== 'string' || vendor.length > 120))
    || !recurrences.has(recurrence) || !Number.isFinite(amountUsd) || amountUsd < 0
    || typeof effectiveAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveAt)
    || (endsAt != null && (typeof endsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endsAt) || endsAt < effectiveAt))) {
    return res.status(400).json({ error: 'Enter a description, category, USD amount, recurrence and valid dates.' });
  }
  const id = `expense-${randomUUID()}`;
  await database().query(`insert into alpha_private.ops_project_expenses
    (id,workspace_id,project_id,description,vendor,category,amount_usd,recurrence,effective_at,ends_at,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [id, workspaceId, project.id, description.trim(), vendor?.trim() || null, category.trim(), roundUsd(amountUsd), recurrence, effectiveAt, endsAt ?? null, req.workspace!.userId]);
  res.status(201).json({ id, projectId: project.id, description: description.trim(), vendor: vendor?.trim() || null,
    category: category.trim(), amountUsd: roundUsd(amountUsd), recurrence, effectiveAt, endsAt: endsAt ?? null, createdBy: req.workspace!.userId, createdAt: new Date().toISOString() });
}));

operationsRouter.delete('/operations/projects/:projectId/expenses/:expenseId', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.manage')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  const deleted = await database().query(`delete from alpha_private.ops_project_expenses where workspace_id=$1 and project_id=$2 and id=$3 returning id`,
    [req.workspace!.workspaceId, req.params.projectId, req.params.expenseId]);
  if (!deleted.rows.length) return res.status(404).json({ error: 'Expense not found.' });
  res.json({ success: true });
}));

operationsRouter.patch('/operations/notifications/read-all', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.read')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  await database().query(`update alpha_private.ops_notifications set read_at=now() where workspace_id=$1 and user_id=$2 and read_at is null`,
    [req.workspace!.workspaceId, req.workspace!.userId]);
  res.json({ success: true });
}));

operationsRouter.patch('/operations/notifications/:id/read', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.read')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const updated = await database().query(`update alpha_private.ops_notifications set read_at=coalesce(read_at,now())
    where workspace_id=$1 and user_id=$2 and id=$3 returning id`, [req.workspace!.workspaceId, req.workspace!.userId, req.params.id]);
  if (!updated.rows.length) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ success: true });
}));

operationsRouter.patch('/operations/notifications/:id/archive', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'operations.read')) return;
  if (!IS_CLOUD) { if (await relayToCloud(req, res)) return; return unavailable(res); }
  const updated = await database().query(`update alpha_private.ops_notifications set archived_at=coalesce(archived_at,now()),read_at=coalesce(read_at,now())
    where workspace_id=$1 and user_id=$2 and id=$3 returning id`, [req.workspace!.workspaceId, req.workspace!.userId, req.params.id]);
  if (!updated.rows.length) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ success: true });
}));

function roundUsd(value: number): number { return Math.round(value * 100) / 100; }
function roundPercent(value: number): number { return Math.round(value * 1000) / 1000; }

function deadlineState(targetDate?: string | null, completedAt?: string | null): 'on_track' | 'late' | 'upcoming' | 'unconfigured' {
  if (!targetDate) return 'unconfigured';
  if (!completedAt) return Date.parse(targetDate) < Date.now() ? 'late' : 'upcoming';
  return Date.parse(completedAt) <= Date.parse(targetDate) ? 'on_track' : 'late';
}

function expenseTotalToDate(expense: { amountUsd: number; recurrence: string; effectiveAt: string; endsAt: string | null }): number {
  const start = new Date(`${expense.effectiveAt}T00:00:00Z`);
  const end = new Date(`${(expense.endsAt && expense.endsAt < new Date().toISOString().slice(0, 10) ? expense.endsAt : new Date().toISOString().slice(0, 10))}T00:00:00Z`);
  if (start > end) return 0;
  if (expense.recurrence === 'one_off') return expense.amountUsd;
  const months = Math.max(1, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1);
  return expense.amountUsd * (expense.recurrence === 'annual' ? Math.ceil(months / 12) : months);
}
