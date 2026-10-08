-- Reviewed staging-only hardening; do not rewrite the deployed baseline.
-- The invoker trigger uses only OLD/NEW and built-ins. No grants, function
-- body, owner, security mode, application rows or managed schemas change.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter function alpha.keep_project_owner() set search_path = '';
