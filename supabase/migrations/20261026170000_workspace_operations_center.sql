-- Workspace Operations Center: real deployment, uptime, ticket SLA and cost data.
-- All operational writes go through the cloud API as the verified workspace admin.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS milestones jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_id_id_unique
  ON public.projects (workspace_id, id);

ALTER TABLE alpha_private.tickets
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none'));

CREATE TABLE alpha_private.ops_monitored_targets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  kind text NOT NULL CHECK (kind IN ('service', 'domain')),
  provider text NOT NULL CHECK (provider IN ('render', 'vercel')),
  url text NOT NULL,
  check_path text NOT NULL,
  availability_target numeric(5,2),
  enabled boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, project_id, repository, environment, kind, url),
  UNIQUE (workspace_id, id),
  CHECK (availability_target IS NULL OR availability_target BETWEEN 0 AND 100)
);

CREATE INDEX ops_monitored_targets_due_idx
  ON alpha_private.ops_monitored_targets (enabled, last_seen_at, workspace_id);

CREATE TABLE alpha_private.ops_workspace_settings (
  workspace_id text PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  production_availability_target numeric(5,2) NOT NULL DEFAULT 99.90
    CHECK (production_availability_target BETWEEN 90 AND 100),
  last_target_discovery_at timestamptz,
  last_deployment_import_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alpha_private.ops_probe_samples (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  target_id text NOT NULL,
  checked_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  status_code integer,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  error text,
  UNIQUE (target_id, checked_at),
  FOREIGN KEY (workspace_id, target_id)
    REFERENCES alpha_private.ops_monitored_targets(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX ops_probe_samples_window_idx
  ON alpha_private.ops_probe_samples (workspace_id, target_id, checked_at DESC);

CREATE TABLE alpha_private.ops_incidents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  target_id text NOT NULL,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, target_id)
    REFERENCES alpha_private.ops_monitored_targets(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ops_incidents_one_open_idx
  ON alpha_private.ops_incidents (target_id) WHERE resolved_at IS NULL;
CREATE INDEX ops_incidents_workspace_timeline_idx
  ON alpha_private.ops_incidents (workspace_id, started_at DESC);

CREATE TABLE alpha_private.ops_deployments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  repository text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('render', 'vercel')),
  provider_deployment_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  status text NOT NULL,
  branch text,
  commit_sha text,
  commit_message text,
  deployment_url text,
  created_by text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, provider, provider_deployment_id)
);

CREATE INDEX ops_deployments_workspace_timeline_idx
  ON alpha_private.ops_deployments (workspace_id, started_at DESC);

CREATE TABLE alpha_private.ops_ticket_sla_policies (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
  response_minutes integer NOT NULL CHECK (response_minutes BETWEEN 1 AND 525600),
  resolution_minutes integer NOT NULL CHECK (resolution_minutes BETWEEN 1 AND 525600),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, priority)
);

CREATE TABLE alpha_private.ops_ticket_sla_events (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  ticket_id text NOT NULL,
  status text NOT NULL,
  action_owner text,
  occurred_at timestamptz NOT NULL,
  legacy_baseline boolean NOT NULL DEFAULT false,
  FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES alpha_private.tickets(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX ops_ticket_sla_events_timeline_idx
  ON alpha_private.ops_ticket_sla_events (workspace_id, ticket_id, occurred_at, id);

INSERT INTO alpha_private.ops_ticket_sla_events
  (workspace_id, ticket_id, status, action_owner, occurred_at, legacy_baseline)
SELECT workspace_id, id, status, workflow_state->>'actionOwner', created_at, true
FROM alpha_private.tickets;

CREATE FUNCTION alpha_private.capture_ops_ticket_sla_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO alpha_private.ops_ticket_sla_events
      (workspace_id, ticket_id, status, action_owner, occurred_at)
    VALUES (NEW.workspace_id, NEW.id, NEW.status, NEW.workflow_state->>'actionOwner', NEW.created_at);
  ELSIF OLD.workflow_state IS DISTINCT FROM NEW.workflow_state OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO alpha_private.ops_ticket_sla_events
      (workspace_id, ticket_id, status, action_owner, occurred_at)
    VALUES (
      NEW.workspace_id, NEW.id, NEW.status, NEW.workflow_state->>'actionOwner',
      greatest(NEW.internal_updated_at, NEW.client_updated_at)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_capture_ops_sla_state
  AFTER INSERT OR UPDATE OF workflow_state, status ON alpha_private.tickets
  FOR EACH ROW EXECUTE FUNCTION alpha_private.capture_ops_ticket_sla_state();

CREATE TABLE alpha_private.ops_project_expenses (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  description text NOT NULL,
  vendor text,
  category text NOT NULL,
  amount_usd numeric(12,2) NOT NULL CHECK (amount_usd >= 0),
  recurrence text NOT NULL CHECK (recurrence IN ('one_off', 'monthly', 'annual')),
  effective_at date NOT NULL,
  ends_at date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE,
  CHECK (ends_at IS NULL OR ends_at >= effective_at)
);

CREATE INDEX ops_project_expenses_period_idx
  ON alpha_private.ops_project_expenses (workspace_id, project_id, effective_at);

CREATE TABLE alpha_private.ops_project_budgets (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  amount_usd numeric(12,2) NOT NULL CHECK (amount_usd >= 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE alpha_private.ops_notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  incident_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('opened', 'resolved')),
  title text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  archived_at timestamptz,
  UNIQUE (user_id, incident_id, event_type),
  FOREIGN KEY (workspace_id, incident_id)
    REFERENCES alpha_private.ops_incidents(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX ops_notifications_user_idx
  ON alpha_private.ops_notifications (workspace_id, user_id, created_at DESC);

CREATE TABLE alpha_private.ops_worker_leases (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE alpha_private.ops_monitored_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_probe_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_ticket_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_ticket_sla_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_project_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_project_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE alpha_private.ops_worker_leases ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  alpha_private.ops_monitored_targets, alpha_private.ops_workspace_settings, alpha_private.ops_probe_samples,
  alpha_private.ops_incidents, alpha_private.ops_deployments,
  alpha_private.ops_ticket_sla_policies, alpha_private.ops_ticket_sla_events,
  alpha_private.ops_project_expenses, alpha_private.ops_project_budgets,
  alpha_private.ops_notifications, alpha_private.ops_worker_leases
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL PRIVILEGES ON FUNCTION alpha_private.capture_ops_ticket_sla_state()
FROM PUBLIC, anon, authenticated, service_role;
